import { useEffect, useRef, useState } from "react";

import { formatBpm } from "@/lib/format";
import { MAX_TEMPO, MIN_TEMPO } from "@/lib/sync";
import { usePreferencesContext } from "@/store/usePreferences";
import styles from "./TempoField.module.css";

export function TempoToggle({ bpmX100, baseBpmX100, onBpmChange, className }: {
  bpmX100: number;
  baseBpmX100: number;
  onBpmChange: (bpm: number) => void;
  className?: string | undefined;
}) {
  const { preferences, update } = usePreferencesContext();
  const [editing, setEditing] = useState(false);
  const clickTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
  }, []);

  if (editing) return (
    <BpmInput bpmX100={bpmX100} baseBpmX100={baseBpmX100} onBpmChange={onBpmChange}
      onDone={() => setEditing(false)} className={className} />
  );

  return (
    <button type="button" className={`${styles.tempoToggle} ${className ?? ""}`}
      aria-label="Toggle tempo slider"
      aria-expanded={preferences.view.tempoSlider}
      title="Double-click to enter BPM"
      data-testid="player-bpm"
      onClick={() => {
        if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          update("view", { tempoSlider: !preferences.view.tempoSlider });
          clickTimer.current = null;
        }, 250);
      }}
      onDoubleClick={() => {
        if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
        clickTimer.current = null;
        setEditing(true);
      }}>
      {formatBpm(bpmX100)}
    </button>
  );
}

/**
 * A BPM typed in: Enter or leaving the field plays the deck at it, Escape
 * leaves the tempo alone. Anything the fader could not reach is ignored.
 */
export function BpmInput({ bpmX100, baseBpmX100, onBpmChange, onDone, className }: {
  bpmX100: number;
  baseBpmX100: number;
  onBpmChange: (bpm: number) => void;
  onDone: () => void;
  className?: string | undefined;
}) {
  const [draft, setDraft] = useState(() => formatBpm(bpmX100));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const valid = (value: string) => {
    const bpm = Number(value);
    return /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && Number.isFinite(bpm)
      && baseBpmX100 > 0 && bpm >= baseBpmX100 / 100 * MIN_TEMPO
      && bpm <= baseBpmX100 / 100 * MAX_TEMPO;
  };
  // Escape unmounts the field before its blur would commit the draft.
  const cancelled = useRef(false);

  return (
    <input
      ref={input}
      className={`${styles.tempoInput} ${className ?? ""}`}
      aria-label="Player tempo in BPM"
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (!cancelled.current && valid(draft)) onBpmChange(Number(draft));
        onDone();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { cancelled.current = true; event.currentTarget.blur(); }
        else if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
