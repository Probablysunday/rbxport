//! The channel strip: trim, three bands, the filter, the channel fader, and
//! the crossfader.
//!
//! One of these per deck, run inside the audio callback. Everything the
//! interface can move is an atomic — the callback must never wait for a knob —
//! and everything the callback applies goes through `smooth`, because a gain
//! that jumps between buffers is a click whatever it is a gain of.
//!
//! The bands are a Linkwitz-Riley four-pole split, which is what sums back to
//! flat: a two-pole split leaves a 3 dB hump at the crossover, and a DJ EQ
//! with every band at centre has to be the track. The low band is run through
//! the second crossover as well and its two halves summed, which is that
//! crossover's all-pass — without it the low band arrives phase-rotated
//! against the other two and the sum dips where they meet.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::smooth::Smoothed;

/// Where the low band ends and the middle begins.
///
/// **[ASSUME]** The DJM-900NXS2 manual quotes the frequencies its EQ is
/// *measured* at — HI 30 kHz, MID 1 kHz, LOW 20 Hz — not where its crossovers
/// sit, and no capture here says what those are. 300 Hz and 4 kHz are the
/// usual places for a three-band DJ EQ: 300 keeps a kick whole in the low band
/// and 4 k puts hats and air in the high one. Settle it by sweeping a real
/// DJM, or a recording of one, before anything depends on the exact number.
const CROSS_LOW_HZ: f32 = 300.0;
const CROSS_HIGH_HZ: f32 = 4_000.0;

/// The most a band can be boosted, in dB. Both curves share it.
const MAX_BOOST_DB: f32 = 6.0;

/// The least a band can be cut in EQ, in dB. ISOLATOR goes to silence instead.
const MIN_EQ_DB: f32 = -26.0;

/// What the three bands do at the ends of their travel.
///
/// The difference is the bottom of the range and nothing else: EQ bottoms out
/// at −26 dB, which still lets a little of the band through, and ISOLATOR
/// bottoms out at silence. Both top out at +6.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Curve {
    Eq,
    Isolator,
}

impl Curve {
    fn from_wire(value: u32) -> Self {
        if value == 1 { Self::Isolator } else { Self::Eq }
    }

    fn to_wire(self) -> u32 {
        match self {
            Self::Eq => 0,
            Self::Isolator => 1,
        }
    }

    /// The gain a band knob at `position` (0 to 1) asks for.
    ///
    /// Centre is unity in both curves, which is what makes a knob at twelve
    /// o'clock the track and not an opinion about it.
    fn gain(self, position: f32) -> f32 {
        let at = position.clamp(0.0, 1.0);
        if at >= 0.5 {
            db_to_gain(MAX_BOOST_DB * (at - 0.5) * 2.0)
        } else {
            match self {
                Self::Eq => db_to_gain(MIN_EQ_DB * (0.5 - at) * 2.0),
                // Straight to silence rather than through −26: an isolator's
                // whole point is that the band goes away.
                Self::Isolator => at * 2.0,
            }
        }
    }

    /// What a kill button drives its band to: the bottom of this curve.
    ///
    /// A kill is not an attenuation of its own — it is the knob at its
    /// minimum, so switching curve changes what killing does, which is what
    /// the mixer it is a clone of does.
    fn killed(self) -> f32 {
        self.gain(0.0)
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// One deck's settings, as the interface leaves them for the callback.
///
/// Every field is an atomic and none of them is ever read as a group, so a
/// knob moved between two of the callback's reads simply lands on the next
/// frame — which is what a knob does.
#[derive(Debug)]
pub struct ChannelSettings {
    /// The trim, 0 to 2 — up to +6 dB, as the gain knob on a mixer gives.
    trim: AtomicU32,
    /// The three band knobs, 0 to 1, centre at 0.5.
    bands: [AtomicU32; 3],
    /// Which of them are killed.
    kills: [AtomicBool; 3],
    /// The channel fader, 0 to 1. Up by default, so a deck plays at its level.
    volume: AtomicU32,
    /// The COLOR FX filter knob, 0 to 1: low-pass left of centre, high-pass
    /// right of it, nothing at centre.
    filter: AtomicU32,
}

impl Default for ChannelSettings {
    fn default() -> Self {
        Self {
            trim: AtomicU32::new(1.0_f32.to_bits()),
            bands: [
                AtomicU32::new(0.5_f32.to_bits()),
                AtomicU32::new(0.5_f32.to_bits()),
                AtomicU32::new(0.5_f32.to_bits()),
            ],
            kills: [AtomicBool::new(false), AtomicBool::new(false), AtomicBool::new(false)],
            volume: AtomicU32::new(1.0_f32.to_bits()),
            filter: AtomicU32::new(0.5_f32.to_bits()),
        }
    }
}

/// Which band a control names. High to low, as the strip is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    High,
    Mid,
    Low,
}

impl Band {
    fn index(self) -> usize {
        match self {
            Self::High => 0,
            Self::Mid => 1,
            Self::Low => 2,
        }
    }

    pub const ALL: [Band; 3] = [Band::High, Band::Mid, Band::Low];
}

impl ChannelSettings {
    pub fn set_trim(&self, trim: f32) {
        let safe = if trim.is_finite() { trim.clamp(0.0, 2.0) } else { 1.0 };
        self.trim.store(safe.to_bits(), Ordering::Relaxed);
    }

    pub fn trim(&self) -> f32 {
        f32::from_bits(self.trim.load(Ordering::Relaxed))
    }

    pub fn set_band(&self, band: Band, position: f32) {
        let safe = if position.is_finite() { position.clamp(0.0, 1.0) } else { 0.5 };
        if let Some(slot) = self.bands.get(band.index()) {
            slot.store(safe.to_bits(), Ordering::Relaxed);
        }
    }

    pub fn band(&self, band: Band) -> f32 {
        self.bands.get(band.index()).map_or(0.5, |slot| f32::from_bits(slot.load(Ordering::Relaxed)))
    }

    pub fn set_kill(&self, band: Band, killed: bool) {
        if let Some(slot) = self.kills.get(band.index()) {
            slot.store(killed, Ordering::Relaxed);
        }
    }

    pub fn killed(&self, band: Band) -> bool {
        self.kills.get(band.index()).is_some_and(|slot| slot.load(Ordering::Relaxed))
    }

    pub fn set_volume(&self, position: f32) {
        let safe = if position.is_finite() { position.clamp(0.0, 1.0) } else { 1.0 };
        self.volume.store(safe.to_bits(), Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    pub fn set_filter(&self, position: f32) {
        let safe = if position.is_finite() { position.clamp(0.0, 1.0) } else { 0.5 };
        self.filter.store(safe.to_bits(), Ordering::Relaxed);
    }

    pub fn filter(&self) -> f32 {
        f32::from_bits(self.filter.load(Ordering::Relaxed))
    }

    /// The gain each band is asking for, high to low.
    fn wanted(&self, curve: Curve) -> [f32; 3] {
        let mut out = [1.0_f32; 3];
        for (i, slot) in out.iter_mut().enumerate() {
            let band = Band::ALL.get(i).copied().unwrap_or(Band::High);
            *slot = if self.killed(band) { curve.killed() } else { curve.gain(self.band(band)) };
        }
        out
    }
}

/// The shape of the crossfader.
///
/// **[UNKNOWN]** What rekordbox's own crossfader does between its ends has not
/// been measured. `Full` is the default because it is the one shape that
/// cannot be wrong in the one-player layout, which has no crossfader at all:
/// it leaves both decks at unity in the middle, so a deck nobody has touched a
/// fader for plays at the level of its file. Settle the real shape against
/// rekordbox before offering the choice as a preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fade {
    /// Unity across the middle, falling to silence only over the far half.
    Full,
    /// Constant power: −3 dB in the middle, so two tracks playing together do
    /// not jump as the fader passes.
    Power,
    /// Scratch: both decks whole until the last few percent of travel, where
    /// the far one cuts out.
    Cut,
}

impl Fade {
    fn from_wire(value: u32) -> Self {
        match value {
            1 => Self::Power,
            2 => Self::Cut,
            _ => Self::Full,
        }
    }

    fn to_wire(self) -> u32 {
        match self {
            Self::Full => 0,
            Self::Power => 1,
            Self::Cut => 2,
        }
    }

    /// What deck A and deck B are multiplied by at `at`, 0 at A and 1 at B.
    fn split(self, at: f32) -> (f32, f32) {
        let at = at.clamp(0.0, 1.0);
        match self {
            Self::Full => (((1.0 - at) * 2.0).min(1.0), (at * 2.0).min(1.0)),
            Self::Power => {
                let angle = at * std::f32::consts::FRAC_PI_2;
                (angle.cos(), angle.sin())
            }
            Self::Cut => (((1.0 - at) / CUT_EDGE).min(1.0), (at / CUT_EDGE).min(1.0)),
        }
    }
}

/// How much of the crossfader's travel the `Cut` curve fades over, at each end.
const CUT_EDGE: f32 = 0.03;

/// The mixer's own settings: the curve both channels use, and the crossfader.
#[derive(Debug)]
pub struct MixerSettings {
    pub channels: [ChannelSettings; 2],
    /// 0 is deck A alone, 1 is deck B alone, 0.5 is both.
    position: AtomicU32,
    curve: AtomicU32,
    fade: AtomicU32,
}

impl Default for MixerSettings {
    fn default() -> Self {
        Self {
            channels: [ChannelSettings::default(), ChannelSettings::default()],
            position: AtomicU32::new(0.5_f32.to_bits()),
            curve: AtomicU32::new(Curve::Eq.to_wire()),
            fade: AtomicU32::new(Fade::Full.to_wire()),
        }
    }
}

impl MixerSettings {
    /// The crossfader, 0 at deck A and 1 at deck B.
    ///
    /// Vertical in rekordbox's 2-player layout — A above, B below — which is
    /// why this is not called left and right.
    pub fn set_crossfade(&self, position: f32) {
        let safe = if position.is_finite() { position.clamp(0.0, 1.0) } else { 0.5 };
        self.position.store(safe.to_bits(), Ordering::Relaxed);
    }

    pub fn crossfade(&self) -> f32 {
        f32::from_bits(self.position.load(Ordering::Relaxed))
    }

    pub fn set_curve(&self, curve: Curve) {
        self.curve.store(curve.to_wire(), Ordering::Relaxed);
    }

    pub fn curve(&self) -> Curve {
        Curve::from_wire(self.curve.load(Ordering::Relaxed))
    }

    pub fn set_fade(&self, fade: Fade) {
        self.fade.store(fade.to_wire(), Ordering::Relaxed);
    }

    pub fn fade(&self) -> Fade {
        Fade::from_wire(self.fade.load(Ordering::Relaxed))
    }

    /// What each deck is multiplied by at the current fader position.
    pub(crate) fn fader(&self) -> (f32, f32) {
        self.fade().split(self.crossfade())
    }
}

/// Below this a filter is taken as having stopped ringing.
///
/// An IIR's tail never actually reaches zero, and the last of it is where
/// denormal floats live — numbers a CPU can be an order of magnitude slower to
/// multiply, in the one place where being slow is an audible fault. −360 dB is
/// far below anything a 32-bit sample can carry anyway, so this costs nothing
/// but a comparison and it makes a stopped deck exactly silent rather than
/// nearly so.
const RUNG_OUT: f32 = 1e-18;

fn flush(value: f32) -> f32 {
    if value.abs() < RUNG_OUT { 0.0 } else { value }
}

/// A one-pole-per-stage biquad, transposed direct form 2.
///
/// Transposed because it is the form that keeps its state small and its
/// arithmetic stable in `f32` at audio rates, which is the whole of why this
/// is not written as a difference equation over a history buffer.
#[derive(Debug, Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// A two-pole Butterworth low or high pass at `hz`.
    fn butterworth(hz: f32, rate: f32, high: bool) -> Self {
        let w = std::f32::consts::TAU * (hz / rate).clamp(1e-5, 0.49);
        let (sin, cos) = w.sin_cos();
        // Q of a Butterworth pair: two of these in series make Linkwitz-Riley.
        let alpha = sin / std::f32::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = if high {
            let half = f32::midpoint(1.0, cos);
            (half, -(1.0 + cos), half)
        } else {
            let half = f32::midpoint(1.0, -cos);
            (half, 1.0 - cos, half)
        };
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// New coefficients, the same state: a moving cutoff must not restart the
    /// filter, or every retune would click.
    fn retune(&mut self, to: Self) {
        *self = Self { z1: self.z1, z2: self.z2, ..to };
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = flush(self.b1 * x - self.a1 * y + self.z2);
        self.z2 = flush(self.b2 * x - self.a2 * y);
        y
    }
}

/// A Linkwitz-Riley four-pole split: two Butterworths of the same corner.
#[derive(Debug, Clone, Copy, Default)]
struct Split {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

impl Split {
    fn at(hz: f32, rate: f32) -> Self {
        Self {
            low: [Biquad::butterworth(hz, rate, false), Biquad::butterworth(hz, rate, false)],
            high: [Biquad::butterworth(hz, rate, true), Biquad::butterworth(hz, rate, true)],
        }
    }

    fn run(&mut self, x: f32) -> (f32, f32) {
        let mut low = x;
        for stage in &mut self.low {
            low = stage.run(low);
        }
        let mut high = x;
        for stage in &mut self.high {
            high = stage.run(high);
        }
        // Neither half is flipped. A two-pole split needs one of them
        // inverted to sum; a four-pole one does not — both halves are 6 dB
        // down at the corner and in phase there, which is the property this
        // costs twice the arithmetic for.
        (low, high)
    }
}

/// The three bands of one audio channel — one of these per side of the stereo.
#[derive(Debug, Clone, Copy, Default)]
struct Bands {
    first: Split,
    second: Split,
    /// The same corner as `second`, run on the low band to all-pass it.
    align: Split,
}

impl Bands {
    fn new(rate: f32) -> Self {
        Self {
            first: Split::at(CROSS_LOW_HZ, rate),
            second: Split::at(CROSS_HIGH_HZ, rate),
            align: Split::at(CROSS_HIGH_HZ, rate),
        }
    }

    /// High, mid and low, in that order.
    fn run(&mut self, x: f32) -> [f32; 3] {
        let (low_raw, rest) = self.first.run(x);
        let (mid, high) = self.second.run(rest);
        // The low band through the second crossover and summed back: that sum
        // is an all-pass, so the low band arrives with the same phase rotation
        // the other two picked up on the way through it.
        let (a, b) = self.align.run(low_raw);
        [high, mid, a + b]
    }
}

/// Where the filter knob stops being centre, in knob travel either side of it.
const FILTER_DEAD: f32 = 0.02;

/// How much travel past the dead zone the filter takes to fade fully in.
///
/// Fading the filtered signal in over the dry one, rather than switching to
/// it, is what keeps the knob silent as it leaves centre: the filter it fades
/// in is wide open there, so it is the track already.
const FILTER_FADE_IN: f32 = 0.08;

/// The ends of the sweeps, in Hz: the low-pass closes down to the first, the
/// high-pass opens up to the second.
const FILTER_LOW_HZ: f32 = 60.0;
const FILTER_HIGH_HZ: f32 = 8_000.0;
/// Where each sweep starts, out of the way of the music.
const FILTER_OPEN_LP_HZ: f32 = 20_000.0;
const FILTER_OPEN_HP_HZ: f32 = 20.0;

/// How far the smoothed knob moves before the filters are retuned. They are
/// retuned per frame while it moves — a coarser step is a staircase in the
/// cutoff and clicks on a fast throw — and not at all while it is still.
const FILTER_RETUNE_STEP: f32 = 1e-5;

/// How far into its sweep the filter knob is, 0 at centre and 1 at either end.
fn filter_depth(position: f32) -> f32 {
    (((position - 0.5).abs() - FILTER_DEAD) / (0.5 - FILTER_DEAD)).clamp(0.0, 1.0)
}

/// How much of the filtered signal is mixed in over the dry one.
fn filter_wet(position: f32) -> f32 {
    (filter_depth(position) / FILTER_FADE_IN).min(1.0)
}

/// The low-pass and high-pass corners at one knob position, in Hz. The side
/// the knob is not on sits wide open.
fn filter_at(position: f32) -> (f32, f32) {
    let depth = filter_depth(position);
    // Exponential in the knob, which is how a cutoff sweep sounds even.
    if position > 0.5 {
        (FILTER_OPEN_LP_HZ, FILTER_OPEN_HP_HZ * (FILTER_HIGH_HZ / FILTER_OPEN_HP_HZ).powf(depth))
    } else {
        (FILTER_OPEN_LP_HZ * (FILTER_LOW_HZ / FILTER_OPEN_LP_HZ).powf(depth), FILTER_OPEN_HP_HZ)
    }
}

/// A four-pole sweep, one per side of the stereo.
#[derive(Debug, Clone, Copy, Default)]
struct Sweep {
    stages: [Biquad; 2],
}

impl Sweep {
    fn retune(&mut self, hz: f32, rate: f32, high: bool) {
        let to = Biquad::butterworth(hz, rate, high);
        for stage in &mut self.stages {
            stage.retune(to);
        }
    }

    fn run(&mut self, x: f32) -> f32 {
        let mut y = x;
        for stage in &mut self.stages {
            y = stage.run(y);
        }
        y
    }
}

/// One deck's strip, as the callback owns it.
#[derive(Debug)]
pub struct Channel {
    rate: f32,
    bands: [Bands; 2],
    gains: [Smoothed; 3],
    trim: Smoothed,
    fader: Smoothed,
    volume: Smoothed,
    filter: Smoothed,
    /// A low-pass and a high-pass per side, both always running. Never one
    /// filter switched between the two: its state from one mode rings as a
    /// crack in the other when the knob is thrown across centre.
    lows: [Sweep; 2],
    highs: [Sweep; 2],
    /// The knob position the filters were last tuned for; NaN before the first.
    tuned_at: f32,
}

impl Channel {
    pub fn new(rate: u32) -> Self {
        let bands = Bands::new(rate as f32);
        Self {
            rate: rate as f32,
            bands: [bands, bands],
            gains: [
                Smoothed::new(1.0, rate),
                Smoothed::new(1.0, rate),
                Smoothed::new(1.0, rate),
            ],
            trim: Smoothed::new(1.0, rate),
            fader: Smoothed::new(1.0, rate),
            volume: Smoothed::new(1.0, rate),
            filter: Smoothed::new(0.5, rate),
            lows: [Sweep::default(), Sweep::default()],
            highs: [Sweep::default(), Sweep::default()],
            tuned_at: f32::NAN,
        }
    }

    /// Runs one deck's audio through its strip, in place.
    ///
    /// `fader` is what the crossfader leaves this deck at. Every gain moves
    /// per frame rather than per buffer, so nothing here can click.
    pub fn process(&mut self, out: &mut [f32], settings: &ChannelSettings, curve: Curve, fader: f32) {
        let wanted = settings.wanted(curve);
        let trim = settings.trim();
        // The channel fader's curve: −6 dB at about 70% of its travel, which
        // is near enough a DJM's default to blend on.
        let volume = settings.volume() * settings.volume();
        let filter = settings.filter();
        for frame in out.chunks_exact_mut(2) {
            let trim = self.trim.step(trim);
            let fader = self.fader.step(fader) * self.volume.step(volume);
            let position = self.filter.step(filter);
            if self.tuned_at.is_nan() || (position - self.tuned_at).abs() >= FILTER_RETUNE_STEP {
                let (low_hz, high_hz) = filter_at(position);
                for sweep in &mut self.lows {
                    sweep.retune(low_hz, self.rate, false);
                }
                for sweep in &mut self.highs {
                    sweep.retune(high_hz, self.rate, true);
                }
                self.tuned_at = position;
            }
            let wet = filter_wet(position);
            let (wet_low, wet_high) = if position > 0.5 { (0.0, wet) } else { (wet, 0.0) };
            let mut gains = [0.0_f32; 3];
            for (slot, (smoothed, target)) in
                gains.iter_mut().zip(self.gains.iter_mut().zip(wanted.iter()))
            {
                *slot = smoothed.step(*target);
            }
            for (side, sample) in frame.iter_mut().enumerate() {
                let Some(bands) = self.bands.get_mut(side) else { continue };
                let split = bands.run(*sample * trim);
                let mut sum = 0.0;
                for (band, gain) in split.iter().zip(gains.iter()) {
                    sum += band * gain;
                }
                // Both run even when dry, so their state is warm when the
                // knob reaches them.
                if let (Some(low), Some(high)) = (self.lows.get_mut(side), self.highs.get_mut(side)) {
                    let (lowered, raised) = (low.run(sum), high.run(sum));
                    sum += (lowered - sum) * wet_low + (raised - sum) * wet_high;
                }
                *sample = sum * fader;
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "unity and silence are exact, and that is the assertion")]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    /// A sine at `hz`, one second of it, mono written to both channels.
    fn tone(hz: f32, frames: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let t = i as f32 / RATE as f32;
            let value = (t * hz * std::f32::consts::TAU).sin();
            out.push(value);
            out.push(value);
        }
        out
    }

    /// The peak of the second half, so the filters' start-up is not measured.
    fn settled_peak(out: &[f32]) -> f32 {
        let half = out.len() / 2;
        out.get(half..).unwrap_or(out).iter().fold(0.0_f32, |a, s| a.max(s.abs()))
    }

    fn run(channel: &mut Channel, settings: &ChannelSettings, curve: Curve, hz: f32) -> f32 {
        let mut audio = tone(hz, RATE as usize / 2);
        channel.process(&mut audio, settings, curve, 1.0);
        settled_peak(&audio)
    }

    #[test]
    fn every_band_at_centre_is_the_track_and_not_an_opinion_about_it() {
        // The whole of why the split is four-pole: at centre the strip has to
        // be transparent at every frequency, including where two bands meet.
        for hz in [50.0, 120.0, 300.0, 800.0, 2_000.0, 4_000.0, 9_000.0] {
            let settings = ChannelSettings::default();
            let mut channel = Channel::new(RATE);
            let peak = run(&mut channel, &settings, Curve::Eq, hz);
            // Measured: the worst of these is 0.13% out, at 9 kHz, and the
            // two crossovers themselves are the flattest points of all.
            assert!(
                (peak - 1.0).abs() < 0.005,
                "at {hz} Hz a flat strip passed {peak}, not 1.0",
            );
        }
    }

    #[test]
    fn killing_the_low_band_takes_the_bass_and_leaves_the_rest() {
        let settings = ChannelSettings::default();
        settings.set_kill(Band::Low, true);
        let mut channel = Channel::new(RATE);
        let bass = run(&mut channel, &settings, Curve::Eq, 60.0);
        let mut channel = Channel::new(RATE);
        let top = run(&mut channel, &settings, Curve::Eq, 8_000.0);
        // −26 dB is a twentieth.
        assert!(bass < 0.08, "the bass was still at {bass}");
        assert!(top > 0.9, "the top was pulled down to {top}");
    }

    #[test]
    fn an_isolator_kill_is_silence_and_an_eq_kill_is_not() {
        let settings = ChannelSettings::default();
        settings.set_kill(Band::Low, true);
        let mut channel = Channel::new(RATE);
        let eq = run(&mut channel, &settings, Curve::Eq, 60.0);
        let mut channel = Channel::new(RATE);
        let iso = run(&mut channel, &settings, Curve::Isolator, 60.0);
        assert!(eq > 0.02, "an EQ kill should still let a little through: {eq}");
        // Not literally nothing: the band is gone, and what is left is the
        // skirt of the band above it, 56 dB down at 60 Hz. That is what an
        // isolator does on a real mixer too — it removes a band, it is not a
        // brick wall.
        assert!(iso < 0.01, "an isolator kill should leave next to nothing: {iso}");
        assert!(iso < eq / 10.0, "an isolator kill should be far below an EQ one");
    }

    #[test]
    fn a_band_at_the_top_of_its_travel_is_six_decibels_up() {
        let settings = ChannelSettings::default();
        settings.set_band(Band::Low, 1.0);
        let mut channel = Channel::new(RATE);
        let peak = run(&mut channel, &settings, Curve::Eq, 60.0);
        let six_db = db_to_gain(6.0);
        assert!((peak - six_db).abs() < 0.06, "the low band boosted to {peak}, not {six_db}");
    }

    #[test]
    fn the_default_fader_leaves_a_deck_nobody_has_touched_at_unity() {
        // The one-player layout draws no crossfader at all, so whatever the
        // engine does by default has to be "play the file at its own level".
        let mixer = MixerSettings::default();
        assert_eq!(mixer.fader(), (1.0, 1.0));
    }

    #[test]
    fn constant_power_holds_the_level_as_it_crosses() {
        // A track on both decks must not jump as the fader passes the middle.
        // Summed in power, since two decks playing different music do not add
        // coherently.
        let mixer = MixerSettings::default();
        mixer.set_fade(Fade::Power);
        for at in [0.0_f32, 0.25, 0.5, 0.75, 1.0] {
            mixer.set_crossfade(at);
            let (a, b) = mixer.fader();
            let power = (a * a + b * b).sqrt();
            assert!((power - 1.0).abs() < 1e-5, "at {at} the pair summed to {power}");
        }
    }

    #[test]
    fn the_ends_of_the_crossfader_are_one_deck_and_nothing_of_the_other() {
        for fade in [Fade::Full, Fade::Power] {
            let mixer = MixerSettings::default();
            mixer.set_fade(fade);
            mixer.set_crossfade(0.0);
            assert_eq!(mixer.fader().0, 1.0, "{fade:?} should leave A whole");
            assert!(mixer.fader().1.abs() < 1e-6, "{fade:?} should silence B");
            mixer.set_crossfade(1.0);
            assert!(mixer.fader().0.abs() < 1e-6, "{fade:?} should silence A");
            assert_eq!(mixer.fader().1, 1.0, "{fade:?} should leave B whole");
        }
    }

    #[test]
    fn the_filter_at_centre_is_the_track() {
        for hz in [60.0, 1_000.0, 9_000.0] {
            let settings = ChannelSettings::default();
            let mut channel = Channel::new(RATE);
            let peak = run(&mut channel, &settings, Curve::Eq, hz);
            assert!((peak - 1.0).abs() < 0.005, "at {hz} Hz the centred filter passed {peak}");
        }
    }

    #[test]
    fn the_filter_left_takes_the_top_and_right_takes_the_bottom() {
        let settings = ChannelSettings::default();
        settings.set_filter(0.1);
        let top = run(&mut Channel::new(RATE), &settings, Curve::Eq, 8_000.0);
        let bass = run(&mut Channel::new(RATE), &settings, Curve::Eq, 60.0);
        assert!(top < 0.01, "a low-pass left the top at {top}");
        assert!(bass > 0.5, "a low-pass took the bass to {bass}");

        settings.set_filter(0.9);
        let top = run(&mut Channel::new(RATE), &settings, Curve::Eq, 8_000.0);
        let bass = run(&mut Channel::new(RATE), &settings, Curve::Eq, 60.0);
        assert!(bass < 0.01, "a high-pass left the bass at {bass}");
        assert!(top > 0.5, "a high-pass took the top to {top}");
    }

    #[test]
    fn a_filter_swept_across_centre_does_not_click() {
        // A full sweep from low-pass to high-pass over half a second: no
        // frame-to-frame jump bigger than a full-scale 1 kHz sine makes itself.
        let settings = ChannelSettings::default();
        settings.set_filter(0.2);
        let mut channel = Channel::new(RATE);
        // Settled at the start of the sweep, so its first buffer is not a
        // 10 ms dive from open to closed.
        channel.process(&mut tone(1_000.0, RATE as usize / 10), &settings, Curve::Eq, 1.0);
        let mut audio = tone(1_000.0, RATE as usize / 2);
        let mut last = 0.0_f32;
        let mut worst = 0.0_f32;
        let steps = 100;
        // Whole frames, so a chunk never starts on a right-hand sample.
        let per = audio.len() / steps / 2 * 2;
        for (i, chunk) in audio.chunks_mut(per).enumerate() {
            settings.set_filter(0.2 + 0.6 * i as f32 / steps as f32);
            channel.process(chunk, &settings, Curve::Eq, 1.0);
            for frame in chunk.chunks_exact(2) {
                let left = frame.first().copied().unwrap_or(0.0);
                worst = worst.max((left - last).abs());
                last = left;
            }
        }
        let sine_step = 2.0 * (std::f32::consts::PI * 1_000.0 / RATE as f32).sin();
        assert!(worst <= sine_step * 1.05, "the sweep jumped by {worst}, a sine steps {sine_step}");
    }

    #[test]
    fn a_filter_flicked_from_low_pass_to_high_pass_does_not_click() {
        // A hand throwing the knob end to end in one buffer, on bass: the
        // low-pass passes it and the high-pass takes it away, and the change
        // between has to be a fade rather than a crack.
        let settings = ChannelSettings::default();
        settings.set_filter(0.1);
        let mut channel = Channel::new(RATE);
        let hz = 50.0;
        let mut audio = tone(hz, RATE as usize / 2);
        let (settle, flick) = audio.split_at_mut(RATE as usize / 5 * 2);
        channel.process(settle, &settings, Curve::Eq, 1.0);
        let mut last = settle.get(settle.len() - 2).copied().unwrap_or(0.0);
        settings.set_filter(0.9);
        channel.process(flick, &settings, Curve::Eq, 1.0);
        let mut worst = 0.0_f32;
        for frame in flick.chunks_exact(2) {
            let left = frame.first().copied().unwrap_or(0.0);
            worst = worst.max((left - last).abs());
            last = left;
        }
        // A click is a step only high frequencies make. Sweeping a filter
        // through the bass is allowed to move it as fast as a 250 Hz tone
        // would; the filter that switched modes jumped thirty times that.
        let bass_step = 2.0 * (std::f32::consts::PI * 250.0 / RATE as f32).sin();
        assert!(worst <= bass_step, "the flick jumped by {worst}, a 250 Hz sine steps {bass_step}");
    }

    #[test]
    fn the_channel_fader_down_is_silence_and_up_is_unity() {
        let settings = ChannelSettings::default();
        let up = run(&mut Channel::new(RATE), &settings, Curve::Eq, 1_000.0);
        assert!((up - 1.0).abs() < 0.005, "a fader up passed {up}");
        settings.set_volume(0.0);
        let down = run(&mut Channel::new(RATE), &settings, Curve::Eq, 1_000.0);
        assert_eq!(down, 0.0);
    }

    #[test]
    fn the_cut_curve_is_both_decks_whole_until_the_edge() {
        let mixer = MixerSettings::default();
        mixer.set_fade(Fade::Cut);
        for at in [0.05_f32, 0.5, 0.95] {
            mixer.set_crossfade(at);
            assert_eq!(mixer.fader(), (1.0, 1.0), "at {at}");
        }
        mixer.set_crossfade(1.0);
        assert!(mixer.fader().0.abs() < 1e-6);
    }

    #[test]
    fn a_knob_at_an_end_is_taken_rather_than_refused() {
        let settings = ChannelSettings::default();
        settings.set_band(Band::Mid, 4.0);
        assert_eq!(settings.band(Band::Mid), 1.0);
        settings.set_band(Band::Mid, f32::NAN);
        assert_eq!(settings.band(Band::Mid), 0.5);
        settings.set_trim(-1.0);
        assert_eq!(settings.trim(), 0.0);
    }
}
