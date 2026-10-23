/**
 * The mixer strip: a gain and three kill buttons per deck, and the crossfader
 * between them.
 *
 * Every size and colour here was measured off the two-player capture by
 * scanning its pixels — the strip is 48pt wide, the kill buttons 36×15 on a
 * 20pt pitch, the fader 53pt of travel with a 28×3 handle. See the `mixer*`
 * tokens.
 *
 * It exists only where there are two decks, which is what rekordbox does: the
 * one-player layout has no mixer and no crossfader, and a deck nobody has
 * touched a fader for plays at the level of its file.
 *
 * Nothing here holds audio state of its own. The engine owns the strip — see
 * `crates/rbl-deck/src/mixer.rs` — and these are the knobs that reach it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CrossfadeCurve, DeckId, EqBand } from "@/ipc/types";
import { getBackend } from "@/ipc/client";
import { keyMap } from "@/lib/keyPresets";
import { detectPlatform, dispatchBinding, eqKillBand } from "@/lib/shortcuts";
import { runCommand, type CommandInput } from "@/lib/commands";
import { useCommands } from "@/store/useCommands";
import { usePreferencesContext } from "@/store/usePreferences";
import styles from "./MixerStrip.module.css";

/** High to low, as the strip is drawn and as the mixer names them. */
const BANDS: ReadonlyArray<{ id: EqBand; label: string }> = [
  { id: "high", label: "HIGH" },
  { id: "mid", label: "MID" },
  { id: "low", label: "LOW" },
];

/** The knob's travel in pixels: a full sweep is this far under the pointer. */
const KNOB_TRAVEL = 120;

/**
 * How close to the middle the crossfader snaps.
 *
 * The centre is a position people aim for and cannot hit by hand on a 53pt
 * fader, so it is a detent — three pixels of it, which is under a millimetre.
 */
const DETENT = 3;

/** Trim as a dB reading, which is what the strip prints above the knob. */
function trimLabel(trim: number): string {
  if (trim <= 0) return "-∞dB";
  const db = 20 * Math.log10(trim);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}dB`;
}

/** Sends to the engine, and shrugs when there is no engine to send to. */
function sendToEngine(run: (backend: Awaited<ReturnType<typeof getBackend>>) => Promise<void>): void {
  void getBackend().then(run).catch(() => {
    // A mixer that cannot reach the engine is a mixer with nothing behind
    // it; the control still moves, and the deck plays as it did.
  });
}

/**
 * A knob: dragged up and down, arrows to step, double-click back to `reset`.
 * The tick sweeps 300°, from down-left at `min` to down-right at `max`.
 */
function Knob({ value, min, max, reset, label, valueText, onChange, className, tickClassName }: {
  value: number;
  min: number;
  max: number;
  reset: number;
  label: string;
  valueText: string;
  onChange: (value: number) => void;
  className: string | undefined;
  tickClassName: string | undefined;
}) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const clamp = (next: number) => Math.min(Math.max(next, min), max);
  const step = (max - min) / 40;
  return (
    <div
      className={className}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuetext={valueText}
      // A click must not take the keyboard: the arrows that browse the
      // library would turn the knob too. Tab still reaches it.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, from: value };
      }}
      onPointerMove={(event) => {
        const from = drag.current;
        // Only a drag that started here, and is still held, turns the knob.
        if (!from || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        // Up is more, which is the direction the knob turns.
        onChange(clamp(from.from + ((from.y - event.clientY) / KNOB_TRAVEL) * (max - min)));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") onChange(clamp(value + step));
        else if (event.key === "ArrowDown") onChange(clamp(value - step));
        else return;
        // The knob's, not the app's: no beat jump or list move as well.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span
        className={tickClassName}
        style={{ rotate: `${((value - min) / (max - min)) * 300 - 150}deg` }}
        aria-hidden
      />
    </div>
  );
}

/**
 * A fader for the PERFORMANCE mixer: a channel fader (vertical, up is 1) or
 * the crossfader (horizontal, deck A at 0). Double-click goes to `reset`.
 */
function Fader({ value, label, vertical = false, reset = vertical ? 1 : 0.5, valueText, onChange }: {
  value: number;
  label: string;
  vertical?: boolean;
  reset?: number;
  valueText?: string;
  onChange: (value: number) => void;
}) {
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = vertical ? (box.bottom - event.clientY) / box.height : (event.clientX - box.left) / box.width;
    if (Number.isFinite(at)) onChange(Math.min(Math.max(at, 0), 1));
  };
  return (
    <div
      className={styles.perfFader}
      data-vertical={vertical || undefined}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuetext={valueText ?? `${Math.round(value * 100)}%`}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }}
      onPointerMove={(event) => {
        // Not any held button passing over it, such as a track being dragged.
        if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
      }}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(event) => {
        const up = vertical ? "ArrowUp" : "ArrowRight";
        const down = vertical ? "ArrowDown" : "ArrowLeft";
        if (event.key === up) onChange(Math.min(value + 0.05, 1));
        else if (event.key === down) onChange(Math.max(value - 0.05, 0));
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span
        className={styles.perfHandle}
        style={vertical ? { bottom: `${value * 100}%` } : { left: `${value * 100}%` }}
        aria-hidden
      />
    </div>
  );
}

const CURVES: ReadonlyArray<{ id: CrossfadeCurve; label: string; title: string }> = [
  { id: "full", label: "SMOOTH", title: "Both decks whole through the middle" },
  { id: "power", label: "POWER", title: "Constant power: no dip or bump as the fader crosses" },
  { id: "cut", label: "CUT", title: "Scratch: both decks whole until the very ends" },
];

/** A band or filter knob as a reading: centre is nothing, either side is how far. */
function centredLabel(position: number): string {
  if (Math.abs(position - 0.5) < 0.005) return "Centre";
  return `${position < 0.5 ? "−" : "+"}${Math.round(Math.abs(position - 0.5) * 200)}%`;
}

interface ChannelMemory {
  trim: number;
  killed: ReadonlySet<EqBand>;
  bands: Record<EqBand, number>;
  filter: number;
  volume: number;
}

const neutralChannel = (): ChannelMemory => ({
  trim: 1, killed: new Set(), bands: { high: 0.5, mid: 0.5, low: 0.5 }, filter: 0.5, volume: 1,
});

/**
 * What the mixer was left at, kept across layout switches.
 *
 * Switching layout remounts the strip but not the engine, so the strip reads
 * back what it showed rather than starting at neutral over an engine that is
 * not. What no mounted strip can show — any mixer at all in 1 PLAYER, the
 * knobs, filter, faders and curves outside PERFORMANCE — goes back to neutral
 * in the engine, so no layout plays a deck through a control it does not draw.
 */
const memory = {
  channels: { a: neutralChannel(), b: neutralChannel() } as Record<DeckId, ChannelMemory>,
  crossfade: 0.5,
  curve: "full" as CrossfadeCurve,
  isolator: false,
};
const mounted = { strip: 0, performance: 0 };

/** Sends the remembered state that the strip being mounted draws. */
function restore(performance: boolean): void {
  for (const deck of ["a", "b"] as const) {
    const channel = memory.channels[deck];
    if (channel.trim !== 1) sendToEngine((backend) => backend.setChannelTrim(deck, channel.trim));
    for (const band of channel.killed) sendToEngine((backend) => backend.setChannelKill(deck, band, true));
    if (!performance) continue;
    for (const { id } of BANDS) {
      if (channel.bands[id] !== 0.5) sendToEngine((backend) => backend.setChannelBand(deck, id, channel.bands[id]));
    }
    if (channel.filter !== 0.5) sendToEngine((backend) => backend.setChannelFilter(deck, channel.filter));
    if (channel.volume !== 1) sendToEngine((backend) => backend.setChannelVolume(deck, channel.volume));
  }
  if (performance && memory.curve !== "full") sendToEngine((backend) => backend.setCrossfadeCurve(memory.curve));
  if (performance && memory.isolator) sendToEngine((backend) => backend.setEqCurve(true));
}

/** Puts back to neutral in the engine whatever no mounted strip draws. */
function neutralise(): void {
  for (const deck of ["a", "b"] as const) {
    const channel = memory.channels[deck];
    if (mounted.strip === 0) {
      if (channel.trim !== 1) sendToEngine((backend) => backend.setChannelTrim(deck, 1));
      for (const band of channel.killed) sendToEngine((backend) => backend.setChannelKill(deck, band, false));
    }
    if (mounted.performance === 0) {
      for (const { id } of BANDS) {
        if (channel.bands[id] !== 0.5) sendToEngine((backend) => backend.setChannelBand(deck, id, 0.5));
      }
      if (channel.filter !== 0.5) sendToEngine((backend) => backend.setChannelFilter(deck, 0.5));
      if (channel.volume !== 1) sendToEngine((backend) => backend.setChannelVolume(deck, 1));
    }
  }
  if (mounted.strip === 0 && memory.crossfade !== 0.5) sendToEngine((backend) => backend.setCrossfade(0.5));
  if (mounted.performance === 0) {
    if (memory.curve !== "full") sendToEngine((backend) => backend.setCrossfadeCurve("full"));
    if (memory.isolator) sendToEngine((backend) => backend.setEqCurve(false));
  }
}

/** One deck's half of the strip: the gain block and the three kill buttons. */
const Channel = memo(function Channel({
  deck, flipped, performance,
}: {
  deck: DeckId;
  /** Deck B's half is the mirror of deck A's, as the capture has it. */
  flipped?: boolean;
  /** The PERFORMANCE channel: every knob, the filter and the channel fader. */
  performance?: boolean;
}) {
  const [trim, setTrim] = useState(() => memory.channels[deck].trim);
  const [killed, setKilled] = useState(() => memory.channels[deck].killed);
  const [bandPositions, setBands] = useState(() => memory.channels[deck].bands);
  const [filter, setFilter] = useState(() => memory.channels[deck].filter);
  const [volume, setVolume] = useState(() => memory.channels[deck].volume);
  useEffect(() => {
    memory.channels[deck] = { trim, killed, bands: bandPositions, filter, volume };
  }, [deck, trim, killed, bandPositions, filter, volume]);

  const send = useCallback(
    (next: number) => {
      setTrim(next);
      sendToEngine((backend) => backend.setChannelTrim(deck, next));
    },
    [deck],
  );

  const toggle = useCallback(
    (band: EqBand) => {
      setKilled((current) => {
        const next = new Set(current);
        if (!next.delete(band)) next.add(band);
        sendToEngine((backend) => backend.setChannelKill(deck, band, next.has(band)));
        return next;
      });
    },
    [deck],
  );

  // The kill buttons' commands for this deck (see `src/lib/commands.ts`):
  // the Keyboard pane's kill keys run them (unbound until assigned), the
  // buttons below call the same `toggle`, and a held key is one press.
  const kill = (band: EqBand) => ({ repeat }: CommandInput) => {
    if (!repeat) toggle(band);
    return true;
  };
  useCommands({ eqKillLow: kill("low"), eqKillMid: kill("mid"), eqKillHigh: kill("high") }, deck);
  const platform = useMemo(detectPlatform, []);
  const overrides = keyMap(usePreferencesContext().preferences.keyboard);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const hit = dispatchBinding(event, platform, event.target as HTMLElement | null, overrides);
      if (hit?.action === undefined || hit.deck !== deck || eqKillBand(hit.action) === null) return;
      if (runCommand(hit.action, { scope: deck, repeat: event.repeat })) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, overrides, platform]);

  const gain = (
    <div className={styles.gain}>
      <span className={styles.readout}>{trimLabel(trim)}</span>
      <Knob
        value={trim}
        min={0}
        max={2}
        reset={1}
        label={`Deck ${deck.toUpperCase()} gain`}
        valueText={trimLabel(trim)}
        onChange={send}
        className={styles.knob}
        tickClassName={styles.tick}
      />
      {/* Auto Gain, which is what rekordbox's A-GAIN means. The knob is the
          trim until there is an analysed gain to switch it to. */}
      <span className={styles.caption}>A-GAIN</span>
    </div>
  );

  const bands = (
    <div className={styles.bands}>
      {BANDS.map((band) => (
        <button
          key={band.id}
          type="button"
          className={styles.band}
          aria-pressed={killed.has(band.id)}
          data-killed={killed.has(band.id) || undefined}
          onClick={() => toggle(band.id)}
        >
          {band.label}
        </button>
      ))}
    </div>
  );

  if (performance) {
    const name = deck.toUpperCase();
    const setBand = (band: EqBand, position: number) => {
      setBands((current) => ({ ...current, [band]: position }));
      sendToEngine((backend) => backend.setChannelBand(deck, band, position));
    };
    const knob = (label: string, value: number, onChange: (value: number) => void, title?: ReactNode) => (
      <div key={label} className={styles.perfKnob}>
        <Knob value={value} min={0} max={1} reset={0.5} label={`Deck ${name} ${label}`}
          valueText={centredLabel(value)} onChange={onChange} className={styles.knob} tickClassName={styles.tick} />
        {title ?? <span className={styles.caption}>{label}</span>}
      </div>
    );
    return (
      <div className={styles.perfChannel} role="group" aria-label={`Channel ${name}`}>
        <div className={styles.perfKnobs}>
        <div className={styles.perfKnob}>
          <Knob value={trim} min={0} max={2} reset={1} label={`Deck ${name} gain`} valueText={trimLabel(trim)}
            onChange={send} className={styles.knob} tickClassName={styles.tick} />
          <span className={styles.caption}>TRIM</span>
        </div>
        {BANDS.map((band) => knob(band.label, bandPositions[band.id], (value) => setBand(band.id, value), (
          // The band's name is its kill: lit while the band is gone.
          <button
            type="button"
            className={styles.perfKill}
            aria-label={`Kill deck ${name} ${band.label.toLowerCase()}`}
            aria-pressed={killed.has(band.id)}
            data-killed={killed.has(band.id) || undefined}
            onClick={() => toggle(band.id)}
          >
            {band.label}
          </button>
        )))}
        {knob("FILTER", filter, (value) => {
          setFilter(value);
          sendToEngine((backend) => backend.setChannelFilter(deck, value));
        })}
        </div>
        <Fader
          value={volume}
          label={`Deck ${name} channel fader`}
          vertical
          onChange={(value) => {
            setVolume(value);
            sendToEngine((backend) => backend.setChannelVolume(deck, value));
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.channel} data-flipped={flipped || undefined}>
      {flipped ? bands : gain}
      {flipped ? gain : bands}
    </div>
  );
});

export interface MixerStripProps {
  /** Told, so the app can keep the fader across a layout change. */
  onCrossfade?: (position: number) => void;
  /** Where the fader starts: 0 is deck A alone, 1 is deck B alone. */
  crossfade?: number;
  /** The PERFORMANCE layout's mixer, between the decks rather than beside them. */
  performance?: boolean;
}

export function MixerStrip({ crossfade = memory.crossfade, onCrossfade, performance = false }: MixerStripProps) {
  const [at, setAt] = useState(crossfade);
  const [curve, setCurve] = useState(memory.curve);
  const [isolator, setIsolator] = useState(memory.isolator);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    memory.crossfade = at;
    memory.curve = curve;
    memory.isolator = isolator;
  }, [at, curve, isolator]);

  useEffect(() => {
    mounted.strip += 1;
    if (performance) mounted.performance += 1;
    restore(performance);
    return () => {
      mounted.strip -= 1;
      if (performance) mounted.performance -= 1;
      // After the layout that replaces this one has mounted its own strip.
      setTimeout(neutralise, 0);
    };
  }, [performance]);

  useEffect(() => {
    void (async () => {
      const backend = await getBackend();
      await backend.setCrossfade(at);
    })().catch(() => {});
    onCrossfade?.(at);
  }, [at, onCrossfade]);

  const move = useCallback((clientY: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    const raw = (clientY - box.top) / box.height;
    const clamped = Math.min(Math.max(raw, 0), 1);
    // The detent, in the fader's own units.
    const snap = DETENT / box.height;
    setAt(Math.abs(clamped - 0.5) < snap ? 0.5 : clamped);
  }, []);

  if (performance) {
    return (
      <div className={styles.perf} role="group" aria-label="Mixer">
        <div className={styles.perfChannels}>
          <Channel deck="a" performance />
          <Channel deck="b" performance />
        </div>
        <div className={styles.perfCross}>
          <span className={styles.deckLabel}>A</span>
          <Fader
            value={at}
            label="Crossfader"
            valueText={at === 0.5 ? "Both decks" : at < 0.5 ? "Towards A" : "Towards B"}
            onChange={(value) => setAt(Math.abs(value - 0.5) < 0.02 ? 0.5 : value)}
          />
          <span className={styles.deckLabel}>B</span>
        </div>
        <div className={styles.perfRow}>
        <div className={styles.perfSwitches} role="group" aria-label="Crossfader curve">
          {CURVES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={styles.perfSwitch}
              title={option.title}
              aria-pressed={curve === option.id}
              data-on={curve === option.id || undefined}
              onClick={() => {
                setCurve(option.id);
                sendToEngine((backend) => backend.setCrossfadeCurve(option.id));
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className={styles.perfSwitches} role="group" aria-label="EQ curve">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              className={styles.perfSwitch}
              aria-pressed={isolator === on}
              data-on={isolator === on || undefined}
              onClick={() => {
                setIsolator(on);
                sendToEngine((backend) => backend.setEqCurve(on));
              }}
            >
              {on ? "ISO" : "EQ"}
            </button>
          ))}
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.strip} role="group" aria-label="Mixer">
      <Channel deck="a" />
      <div className={styles.fader}>
        <span className={styles.deckLabel}>A</span>
        <div
          ref={track}
          className={styles.faderTrack}
          role="slider"
          tabIndex={0}
          aria-label="Crossfader"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(at.toFixed(2))}
          aria-valuetext={at === 0.5 ? "Both decks" : at < 0.5 ? "Towards A" : "Towards B"}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            move(event.clientY);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 0) return;
            move(event.clientY);
          }}
          onDoubleClick={() => setAt(0.5)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setAt((v) => Math.max(v - 0.05, 0));
            if (event.key === "ArrowDown") setAt((v) => Math.min(v + 0.05, 1));
          }}
        >
          <span className={styles.faderHandle} style={{ top: `${at * 100}%` }} aria-hidden />
        </div>
        <span className={styles.deckLabel}>B</span>
      </div>
      <Channel deck="b" flipped />
    </div>
  );
}
