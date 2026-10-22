/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import type { runCommand as RunCommand } from "@/lib/commands";
import type { PreferencesProvider as Provider } from "@/store/usePreferences";
import type { MixerStrip as Strip } from "./MixerStrip";

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean; }

const setChannelKill = vi.fn(() => Promise.resolve());
const setChannelVolume = vi.fn(() => Promise.resolve());
const setChannelFilter = vi.fn(() => Promise.resolve());
const setCrossfadeCurve = vi.fn(() => Promise.resolve());
const done = () => Promise.resolve();
vi.mock("@/ipc/client", () => ({
  getBackend: () => Promise.resolve({
    setChannelKill, setChannelVolume, setChannelFilter, setCrossfadeCurve,
    setChannelTrim: done, setCrossfade: done, setChannelBand: done, setEqCurve: done,
  }),
}));

let host: HTMLDivElement;
let root: Root;
// A fresh module each test: the strip remembers what it was left at across
// remounts, which is the point, and would carry one test into the next.
// The provider and the command registry come with it, so they are its own.
let MixerStrip: typeof Strip;
let PreferencesProvider: typeof Provider;
let runCommand: typeof RunCommand;

function mount(overrides: Record<string, { key: string; shiftKey?: boolean }>, performance = false) {
  const preferences = { ...DEFAULT_PREFERENCES, keyboard: { ...DEFAULT_PREFERENCES.keyboard, overrides } };
  act(() => root.render(
    <PreferencesProvider value={{ preferences, update: vi.fn(), reset: vi.fn() }}>
      <MixerStrip performance={performance} />
    </PreferencesProvider>,
  ));
}

/** Lets the strip's unmount reach the engine: it waits a turn for the next strip. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetModules();
  ({ MixerStrip } = await import("./MixerStrip"));
  ({ PreferencesProvider } = await import("@/store/usePreferences"));
  ({ runCommand } = await import("@/lib/commands"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  for (const mock of [setChannelKill, setChannelVolume, setChannelFilter, setCrossfadeCurve]) mock.mockClear();
});
afterEach(async () => { act(() => root.unmount()); host.remove(); await settle(); });

const press = (init: KeyboardEventInit) =>
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });

it("toggles the assigned deck's band kill from the keyboard", async () => {
  mount({ "a.eqKillLow": { key: "z" }, "b.eqKillHigh": { key: "u" } });
  press({ key: "z" });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenCalledWith("a", "low", true);
  press({ key: "z" });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenLastCalledWith("a", "low", false);
  press({ key: "u" });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenLastCalledWith("b", "high", true);
});

it("does nothing while the kill keys are unbound", async () => {
  mount({});
  press({ key: "z" });
  await act(async () => {});
  expect(setChannelKill).not.toHaveBeenCalled();
});

it("kills a band the same way from its command as from its key (#431)", async () => {
  mount({ "b.eqKillMid": { key: "y" } });
  press({ key: "y" });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenLastCalledWith("b", "mid", true);
  act(() => {
    expect(runCommand("eqKillMid", { scope: "b" })).toBe(true);
  });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenLastCalledWith("b", "mid", false);
  // A held key's repeat is the same one press.
  act(() => {
    runCommand("eqKillMid", { scope: "b", repeat: true });
  });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenCalledTimes(2);
});

it("puts the PERFORMANCE controls back to neutral when a layout without them replaces it", async () => {
  mount({}, true);
  const fader = host.querySelector<HTMLElement>('[aria-label="Deck A channel fader"]')!;
  act(() => { fader.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  act(() => { host.querySelector<HTMLButtonElement>('button[title^="Scratch"]')!.click(); });
  await act(async () => {});
  expect(setChannelVolume).toHaveBeenLastCalledWith("a", 0.95);
  expect(setCrossfadeCurve).toHaveBeenLastCalledWith("cut");

  // 2 PLAYER has no channel fader and no curve: the engine goes back to neutral.
  mount({}, false);
  await settle();
  expect(setChannelVolume).toHaveBeenLastCalledWith("a", 1);
  expect(setCrossfadeCurve).toHaveBeenLastCalledWith("full");

  // Back in PERFORMANCE, the strip shows and the engine gets what was left.
  mount({}, true);
  await settle();
  expect(setChannelVolume).toHaveBeenLastCalledWith("a", 0.95);
  expect(setCrossfadeCurve).toHaveBeenLastCalledWith("cut");
  expect(host.querySelector('[aria-label="Deck A channel fader"]')!.getAttribute("aria-valuenow")).toBe("0.95");
});

it("keeps a kill across a layout switch, and drops it where no mixer is drawn", async () => {
  mount({ "a.eqKillLow": { key: "z" } });
  press({ key: "z" });
  await act(async () => {});
  expect(setChannelKill).toHaveBeenLastCalledWith("a", "low", true);
  mount({}, true);
  await settle();
  expect(host.querySelector('[aria-label="Kill deck A low"]')!.getAttribute("aria-pressed")).toBe("true");
  act(() => root.unmount());
  await settle();
  expect(setChannelKill).toHaveBeenLastCalledWith("a", "low", false);
  root = createRoot(host);
});

