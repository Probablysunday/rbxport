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
