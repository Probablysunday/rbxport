/**
 * The PERFORMANCE layout, after rekordbox 7's 2 Deck Horizontal: both detail
 * waveforms stacked across the top, then deck A, the mixer and deck B side by
 * side, with CUE and PLAY in each deck's title row.
 */
import { expect, test, type Page } from "@playwright/test";

async function performance(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("browser-title")).toContainText("Tracks)");
  await page.getByRole("button", { name: "Layout" }).click();
  await page.getByRole("menuitemradio", { name: "PERFORMANCE" }).click();
  await page.locator('[role="gridcell"][data-col="title"]').first().dblclick();
  const cell = page.locator('[role="gridcell"][data-col="title"]').nth(1);
  await cell.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Track" });
  await menu.getByRole("menuitem", { name: "Load", exact: true }).hover();
  await menu.getByRole("menuitem", { name: "Load track to player 2" }).click();
  const a = page.getByRole("region", { name: "Preview player", exact: true });
  const b = page.getByRole("region", { name: "Preview player B" });
  await expect(b.getByTestId("player-title")).not.toHaveText("");
  return { a, b };
}

test("the waveforms stack over the decks, which sit either side of the mixer", async ({ page }) => {
  const { a, b } = await performance(page);
  const mixer = (await page.getByRole("group", { name: "Mixer" }).boundingBox())!;
  const deckA = (await a.boundingBox())!;
  const deckB = (await b.boundingBox())!;
  expect(deckA.x + deckA.width).toBeLessThanOrEqual(mixer.x + 1);
  expect(deckB.x).toBeGreaterThanOrEqual(mixer.x + mixer.width - 1);
  expect(deckA.y).toBeCloseTo(deckB.y, 0);

  // The details are no longer inside the decks: both sit above them, A's on top.
  const detailA = (await page.getByTestId("player-detail").nth(0).boundingBox())!;
  const detailB = (await page.getByTestId("player-detail").nth(1).boundingBox())!;
  expect(bottom(detailA)).toBeLessThanOrEqual(detailB.y + 1);
  expect(bottom(detailB)).toBeLessThanOrEqual(deckA.y + 1);
  expect(detailA.width).toBeGreaterThan(deckA.width * 1.5);

  // CUE and PLAY are in the title row, level with the title.
  const title = (await a.getByTestId("player-title").boundingBox())!;
  const play = (await a.getByRole("button", { name: "Play", exact: true }).boundingBox())!;
  expect(play.y).toBeLessThan(title.y + title.height);
  expect(play.y + play.height).toBeGreaterThan(title.y);
});

test("the mixer has every channel control and the crossfader curves", async ({ page }) => {
  await performance(page);
  const mixer = page.getByRole("group", { name: "Mixer" });
  for (const deck of ["A", "B"]) {
    for (const knob of ["gain", "HIGH", "MID", "LOW", "FILTER"]) {
      await expect(mixer.getByRole("slider", { name: `Deck ${deck} ${knob}` })).toBeVisible();
    }
    await expect(mixer.getByRole("slider", { name: `Deck ${deck} channel fader` })).toBeVisible();
  }
  const kill = mixer.getByRole("button", { name: "Kill deck A low" });
  await kill.click();
  await expect(kill).toHaveAttribute("aria-pressed", "true");
  const cut = mixer.getByRole("button", { name: "CUT" });
  await cut.click();
  await expect(cut).toHaveAttribute("aria-pressed", "true");
  await expect(mixer.getByRole("slider", { name: "Crossfader" })).toBeVisible();
});

test("KEY SYNC on deck B shifts it into a key that mixes with the master's", async ({ page }) => {
  const { b } = await performance(page);
  const keySync = b.getByRole("button", { name: "Key sync" });
  await keySync.click();
  await expect(keySync).toHaveAttribute("aria-pressed", "true");
  // The mock's first two rows: A (11B) on the master, Em (9A) on deck B. Em
  // is two numbers off; two semitones up makes it F#m, 11A, which mixes.
  await expect(b.getByTestId("key-shift")).toHaveText("+2");
  // A key moved by hand is no longer synced.
  await b.getByRole("button", { name: "Key up a semitone" }).click();
  await expect(keySync).toHaveAttribute("aria-pressed", "false");
});

const bottom = (b: { y: number; height: number }) => b.y + b.height;

test("a click on a deck's waveform up top arms that deck", async ({ page }) => {
  const { a, b } = await performance(page);
  await page.getByTestId("player-detail").nth(1).click();
  await expect(b).toHaveAttribute("data-armed", "");
  await expect(a).not.toHaveAttribute("data-armed", "");
});

test("KEY SYNC lets go of a deck in 1 PLAYER, where there is no master to follow", async ({ page }) => {
  const { a, b } = await performance(page);
  await b.getByRole("button", { name: "Sync master" }).click();
  await a.getByRole("button", { name: "Key sync" }).click();
  await expect(a.getByRole("button", { name: "Key sync" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Layout" }).click();
  await page.getByRole("menuitemradio", { name: "1 PLAYER" }).click();
  const deck = page.getByRole("region", { name: "Preview player", exact: true });
  await deck.getByRole("button", { name: "Reset key shift" }).click();
  await expect(deck.getByTestId("key-shift")).toHaveCount(0);
  await deck.getByRole("button", { name: "Key up a semitone" }).click();
  await expect(deck.getByTestId("key-shift")).toHaveText("+1");
});

test("each deck has its tempo fader to hand, and dragging it changes the tempo", async ({ page }) => {
  const { a, b } = await performance(page);
  await expect(b.getByRole("slider", { name: "Tempo" })).toBeVisible();
  const fader = a.getByRole("slider", { name: "Tempo" });
  const box = (await fader.boundingBox())!;
  // Down is faster, as on a CDJ.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.9);
  // The readout under the pointer is the BPM the deck now plays at, not a percentage.
  await expect(page.locator("output").filter({ hasText: /^\d+\.\d{2} BPM$/ })).toBeVisible();
  await page.mouse.up();
  await expect(fader).toHaveAttribute("aria-valuetext", /^\d+\.\d{2} BPM$/);
  await expect.poll(async () => Number(await fader.getAttribute("aria-valuenow"))).toBeGreaterThan(1);
  // RESET goes back to the track's own speed and leaves the fader free.
  await a.getByRole("button", { name: "Reset tempo" }).click();
  await expect(fader).toHaveAttribute("aria-valuenow", "0");
  await expect(fader).toHaveAttribute("aria-disabled", "false");
});

test("a double-click on the BPM under the tempo fader types a tempo in", async ({ page }) => {
  const { a } = await performance(page);
  await a.getByRole("button", { name: "Type a tempo" }).dblclick();
  const field = a.getByRole("textbox", { name: "Player tempo in BPM" });
  await field.fill("130");
  await field.press("Enter");
  await expect(a.getByTestId("player-bpm")).toHaveText("130.00");
  await expect(a.getByRole("button", { name: "Type a tempo" })).toHaveText("130.00");

  // Escape leaves the tempo where it was.
  await a.getByRole("button", { name: "Type a tempo" }).dblclick();
  await field.fill("120");
  await field.press("Escape");
  await expect(a.getByTestId("player-bpm")).toHaveText("130.00");
});

test("controls only move when they are what was grabbed", async ({ page }) => {
  const { a } = await performance(page);
  const mixer = page.getByRole("group", { name: "Mixer" });
  const fader = mixer.getByRole("slider", { name: "Deck A channel fader" });
  const high = mixer.getByRole("slider", { name: "Deck A HIGH" });
  const tempo = a.getByRole("slider", { name: "Tempo" });

  // A button held down elsewhere and swept across the fader leaves it be.
  const box = (await fader.boundingBox())!;
  await page.mouse.move(box.x - 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, { steps: 5 });
  await page.mouse.up();
  await expect(fader).toHaveAttribute("aria-valuenow", "1");

  // Grabbing a knob or the tempo fader does not leave the arrow keys on it.
  const knob = (await high.boundingBox())!;
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(knob.x + knob.width / 2, knob.y - 20, { steps: 4 });
  await page.mouse.up();
  const turned = await high.getAttribute("aria-valuenow");
  expect(Number(turned)).toBeGreaterThan(0.5);
  await page.keyboard.press("ArrowDown");
  await expect(high).toHaveAttribute("aria-valuenow", turned!);

  const t = (await tempo.boundingBox())!;
  await page.mouse.click(t.x + t.width / 2, t.y + t.height * 0.7);
  const set = await tempo.getAttribute("aria-valuenow");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(tempo).toHaveAttribute("aria-valuenow", set!);
});

test("a phrase label is whole, shortened or left out, never clipped", async ({ page }) => {
  for (const width of [1100, 1800]) {
    await page.setViewportSize({ width, height: 900 });
    await performance(page);
    const blocks = await page.getByTestId("player-phrase").first().evaluate((bar) =>
      [...bar.children].map((b) => ({ text: b.textContent ?? "", clipped: b.scrollWidth > b.clientWidth + 1 })));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.filter((b) => b.clipped), `${width}px`).toEqual([]);
    expect(blocks.some((b) => b.text !== ""), `${width}px`).toBe(true);
  }
});

test("with Load lock on, a playing deck keeps its track until it is paused", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("rbl.preferences", JSON.stringify({ view: { loadLock: true } })));
  const { a, b } = await performance(page);
  const titles = page.locator('[role="gridcell"][data-col="title"]');
  const loaded = a.getByTestId("player-title");
  const first = (await loaded.innerText()).trim();
  await a.getByRole("button", { name: "Play", exact: true }).click();
  await titles.nth(4).dblclick();
  await expect(page.getByRole("contentinfo")).toContainText("Deck A is playing. Pause it to load another track.");
  await expect(loaded).toHaveText(first);
  // The other deck is not playing, and takes a track as before.
  const before = (await b.getByTestId("player-title").innerText()).trim();
  await titles.nth(5).dragTo(b);
  await expect(b.getByTestId("player-title")).not.toHaveText(before);
  // Paused, deck A loads again.
  await a.getByRole("button", { name: "Pause", exact: true }).click();
  await titles.nth(4).dblclick();
  await expect(loaded).toHaveText((await titles.nth(4).innerText()).trim());
});

test("one zoom serves both waveforms, and the overview never seeks before the track", async ({ page }) => {
  // Each deck left at its own zoom by an earlier version: they must come back as one.
  await page.addInitScript(() => {
    const raw = JSON.parse(localStorage.getItem("rbl.session") ?? "{}");
    localStorage.setItem("rbl.session", JSON.stringify({ ...raw, waveformZoom: { a: 8, b: 32 } }));
  });
  const { a } = await performance(page);
  // A single + RST − for the pair, not one per deck.
  await expect(page.getByRole("group", { name: "Waveform zoom" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Zoom in" })).toHaveCount(1);
  const spacing = (i: number) => page.getByTestId("player-detail").nth(i).evaluate((detail) => {
    const lines = [...detail.querySelectorAll<HTMLElement>("[data-beat-ms]")].map((l) => l.getBoundingClientRect().left).sort((x, y) => x - y);
    return lines.length > 1 ? lines[1]! - lines[0]! : 0;
  });
  const before = [await spacing(0), await spacing(1)];
  // The same scale on both, from the start and after a press.
  expect(Math.abs(before[0]! - before[1]!)).toBeLessThan(2);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(() => spacing(0)).not.toBe(before[0]);
  await expect.poll(async () => Math.abs((await spacing(0)) - (await spacing(1)))).toBeLessThan(2);

  // A press at the start of the overview that drifts left lands on 0, not before it.
  const box = (await a.getByTestId("player-overview").boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 30, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(a.getByTestId("player-overview")).toHaveAttribute("aria-valuenow", "0");
});
