import * as accessibility from "@swipt/api/accessibility";
import type {
  AccessibilityElement,
  AccessibilitySelector,
} from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import type { Point, Rect } from "@swipt/api";
import type { RasterImage } from "@swipt/api/image";
import * as input from "@swipt/api/input";
import * as screen from "@swipt/api/screen";
import type { ScreenStream } from "@swipt/api/screen";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

import {
  closeRules,
  genericRules,
  rules,
  sdkCloseRules,
  sdkRules,
  type Close,
  type Rule,
} from "./rules";
import {
  appendRecord,
  readControls,
  readSettings,
  recordedApps,
  writeControls,
  type SkipControl,
} from "./storage";

const rewarded: Rule = { within: { class: /Reward|Incentive/i } };
const ownApps = /^(?:com\.apple\.|io\.nekohasekai\.swipt(?:\.|$))/;
// These apps warn about screen recording while the device streams its screen.
const captureWarningApps = new Set(["com.unionpay.chsp", "com.uniqlo.cn"]);

const adWindowMs = 5_000;
const repeatDistance = 40;
const learnedLimit = 4;
const learnedMargin = 20;

const skipText = /跳过/;
const skipTextHeight = 10;
const skipTextLanguages = ["zh-Hans"];
const freshFrameMs = 400;
const textVanishMs = 1_000;
const controlVanishMs = 1_500;

const popupWindowMs = 5_000;
const closeSize = 80;
const largeCloseSize = { width: 240, height: 80 };
const closeLimit = 3;
const closeAttempts = 2;
const swipeMs = 250;

export interface SupportedApp {
  bundleId: string;
  name: string;
  version?: string;
  icon: string;
}

export interface RecordedApp {
  bundleId: string;
  name: string;
  icon?: string;
}

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

interface PendingTap {
  readonly point: Point;
  readonly aim: AbortController;
  delivered: boolean;
  readonly done: Promise<void>;
}

interface Round {
  readonly app: string;
  readonly launched: number;
  readonly started: number;
  readonly screenSize: ScreenSize;
  readonly fuzzy: boolean;
  readonly selectors: Rule[];
  readonly learned: SkipControl[];
  readonly signal: AbortSignal;
  readonly skipping: AbortSignal;
  readonly taps: Set<PendingTap>;
  skipped(): void;
  log(message: string): void;
}

interface SkipText {
  readonly text: string;
  readonly frame: Rect;
  readonly center: Point;
  readonly image: RasterImage;
}

const describe = (element: AccessibilityElement) =>
  `${element.class ?? element.role}@[${element.frame?.map(Math.round) ?? "no frame"}]`;

const centerOf = ([x, y, width, height]: Rect): Point => [
  x + width / 2,
  y + height / 2,
];

const distance = ([ax, ay]: Point, [bx, by]: Point) =>
  Math.hypot(ax - bx, ay - by);

const covers = ([x, y, width, height]: Rect, [px, py]: Point) =>
  px >= x && px <= x + width && py >= y && py <= y + height;

const around = (
  [x, y, width, height]: Rect,
  { width: screenWidth, height: screenHeight }: ScreenSize,
): Rect => {
  const left = Math.max(0, x - learnedMargin);
  const top = Math.max(0, y - learnedMargin);
  return [
    left,
    top,
    Math.min(screenWidth, x + width + learnedMargin) - left,
    Math.min(screenHeight, y + height + learnedMargin) - top,
  ];
};

const adTimeLeft = (round: Round) => adWindowMs - (Date.now() - round.started);

const claimTap = async (round: Round, point: Point) => {
  const pending = [...round.taps].find(
    (tap) => distance(tap.point, point) < repeatDistance,
  );
  if (pending?.delivered) {
    await pending.done;
    return null;
  }
  pending?.aim.abort();
  let release!: () => void;
  const tap: PendingTap = {
    point,
    aim: new AbortController(),
    delivered: false,
    done: new Promise((resolve) => {
      release = resolve;
    }),
  };
  round.taps.add(tap);
  return {
    tap,
    release: () => {
      round.taps.delete(tap);
      release();
    },
  };
};

const controlAfterTap = async (
  selectors: AccessibilitySelector[],
  same: (element: AccessibilityElement) => boolean,
  signal: AbortSignal,
) => {
  const deadline = Date.now() + controlVanishMs;
  let still: AccessibilityElement | null;
  do {
    still = await accessibility.find(selectors, { signal });
  } while (still !== null && same(still) && Date.now() < deadline);
  return still !== null && same(still) ? still : null;
};

const learn = async (
  round: Round,
  frame: Rect,
  control: string | undefined,
  how: string,
) => {
  const same = round.learned.find(
    (learned) =>
      distance(centerOf(learned.frame), centerOf(frame)) < repeatDistance,
  );
  if (same === undefined) {
    if (round.learned.length >= learnedLimit) {
      return;
    }
    round.learned.push({ frame, class: control });
    round.log(`learned ${how} at [${frame.map(Math.round)}]`);
  } else if (control === undefined || same.class !== undefined) {
    return;
  } else {
    same.class = control;
    round.log(`${how} is the learned control`);
  }
  await writeControls(round.app, round.learned);
};

const skipByAccessibility = async (round: Round) => {
  while (!round.skipping.aborted) {
    const timeLeft = adTimeLeft(round);
    if (timeLeft <= 0) {
      return;
    }
    const found = await accessibility.find(round.selectors, {
      timeoutMs: timeLeft,
      poll: true,
      pollTimeoutMs: adWindowMs,
      signal: round.skipping,
    });
    if (found === null) {
      return;
    }
    const detected = Date.now();
    const control = describe(found);
    if (found.frame === undefined) {
      round.log(`${control} has no position`);
      continue;
    }
    const claim = await claimTap(round, centerOf(found.frame));
    if (claim === null) {
      continue;
    }
    try {
      const tapping = Date.now();
      try {
        await accessibility.tap(found, {
          // A short cap keeps the hit-test refusal from eating the whole ad
          // window before the raw-tap fallback below gets its turn.
          timeoutMs: Math.min(timeLeft, 800),
          signal: AbortSignal.any([round.skipping, claim.tap.aim.signal]),
        });
      } catch (error) {
        if (claim.tap.aim.signal.aborted && !round.skipping.aborted) {
          continue;
        }
        if ((error as Error).name !== "TimeoutError") {
          throw error;
        }
        round.log(`${control} cannot be tapped: ${(error as Error).message}`);
        // The SDK refuses element taps whose point resolves to an unlabeled
        // child view (seen on 一码贵州). Fall back to a raw coordinate tap.
        const frame = found.frame;
        if (frame === undefined) {
          continue;
        }
        try {
          await input.tap(
            [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2],
            { signal: round.skipping },
          );
          claim.tap.delivered = true;
          round.log(
            `forced a raw input tap on ${control} at [${Math.round(frame[0] + frame[2] / 2)},${Math.round(frame[1] + frame[3] / 2)}]`,
          );
        } catch {
          continue;
        }
      }
      claim.tap.delivered = true;
      const tapMs = Date.now() - tapping;
      round.log(`tapped ${control} in ${tapMs}ms`);
      if (
        (await controlAfterTap(round.selectors, () => true, round.skipping)) !==
        null
      ) {
        round.log(`${control} is still there after the tap`);
        continue;
      }
      const gone = Date.now();
      round.skipped();
      await learn(round, found.frame, found.class ?? found.role, control);
      await appendRecord({
        time: tapping,
        app: round.app,
        fuzzy: round.fuzzy,
        quick: false,
        ms: tapping - round.launched,
        text: found.label ?? found.class ?? "",
        kind: "skip",
        detected: detected - round.launched,
        tapMs,
        gone: gone - round.launched,
      });
      return;
    } finally {
      claim.release();
    }
  }
};

const findSkipText = async (
  image: RasterImage,
  regions: readonly Rect[],
  signal: AbortSignal,
): Promise<SkipText | null> => {
  const found = await Promise.all(
    regions.map(async (region) => {
      const lines = await image.recognizeText({
        region,
        languages: skipTextLanguages,
        minimumHeight: skipTextHeight,
        signal,
      });
      for (const line of lines) {
        const match = skipText.exec(line.text);
        if (match !== null) {
          const box =
            line.boundingBox(match.index, match.index + match[0].length) ??
            line;
          return {
            text: match[0],
            frame: box.frame,
            center: box.center,
            image,
          };
        }
      }
      return null;
    }),
  );
  return found.find((it) => it !== null) ?? null;
};

const textAfterTap = async (
  stream: ScreenStream,
  regions: readonly Rect[],
  point: Point,
  signal: AbortSignal,
) => {
  const watching = AbortSignal.any([signal, AbortSignal.timeout(textVanishMs)]);
  let shown: SkipText | null = null;
  try {
    for await (const image of stream.frames.values({ signal: watching })) {
      shown = await findSkipText(image, regions, watching);
      if (shown === null || !covers(shown.frame, point)) {
        return shown;
      }
    }
  } catch (error) {
    if (signal.aborted || !watching.aborted) {
      throw error;
    }
  }
  return shown;
};

const skipOnScreen = async (round: Round) => {
  const regions = round.learned.map((learned) =>
    around(learned.frame, round.screenSize),
  );
  const window = AbortSignal.any([
    round.skipping,
    AbortSignal.timeout(Math.max(adTimeLeft(round), 0)),
  ]);
  let stream: ScreenStream;
  try {
    stream = await screen.open({ signal: window });
  } catch (error) {
    if (window.aborted) {
      return;
    }
    throw error;
  }
  const latest = async (signal: AbortSignal) =>
    findSkipText(await stream.frames.get({ signal }), regions, signal);
  try {
    for await (const image of stream.frames.values({ signal: window })) {
      const shown = await findSkipText(image, regions, window);
      if (shown === null) {
        continue;
      }
      const detected = Date.now();
      const age =
        shown.image.timestamp === null ? 0 : detected - shown.image.timestamp;
      const how = `"${shown.text}"`;
      round.log(
        `screen shows ${how} at [${shown.center.map(Math.round)}], frame from ${Math.round(age)}ms ago`,
      );
      let frame = shown.frame;
      if (age > freshFrameMs) {
        const still = await latest(window);
        if (still === null) {
          round.log(`${how} is gone`);
          continue;
        }
        frame = still.frame;
      }
      const point = centerOf(frame);
      const claim = await claimTap(round, point);
      if (claim === null) {
        continue;
      }
      try {
        const tapping = Date.now();
        claim.tap.delivered = true;
        await input.tap(point, { signal: window });
        const tapMs = Date.now() - tapping;
        round.log(`tapped [${point.map(Math.round)}] for ${how} in ${tapMs}ms`);
        const still = await textAfterTap(stream, regions, point, round.signal);
        if (still === null) {
          const gone = Date.now();
          round.skipped();
          await learn(round, frame, undefined, how);
          await appendRecord({
            time: tapping,
            app: round.app,
            fuzzy: round.fuzzy,
            quick: true,
            ms: tapping - round.launched,
            text: shown.text,
            kind: "skip",
            appeared:
              shown.image.timestamp === null
                ? undefined
                : shown.image.timestamp - round.launched,
            detected: detected - round.launched,
            tapMs,
            gone: gone - round.launched,
          });
          return;
        }
        if (covers(still.frame, point)) {
          round.log(`${how} is still there after the tap`);
        } else {
          round.log(
            `${how} moved to [${still.center.map(Math.round)}] after the tap`,
          );
        }
      } finally {
        claim.release();
      }
    }
  } catch (error) {
    if (!window.aborted) {
      throw error;
    }
  } finally {
    await stream.close();
  }
};

const closePopups = async (
  round: Round,
  shownAt: number,
  candidates: Close[],
) => {
  const swipe = candidates[0]?.swipe;
  const large = candidates[0]?.large === true;
  const selectors = candidates.map(({ swipe: _, large: __, ...rule }) => rule);
  const attempts = new Map<string, number>();
  let closed = 0;
  while (!round.signal.aborted && closed < closeLimit) {
    const timeLeft = popupWindowMs - (Date.now() - shownAt);
    if (timeLeft <= 0) {
      return;
    }
    const found = await accessibility.find(selectors, {
      timeoutMs: timeLeft,
      signal: round.signal,
    });
    if (found === null) {
      return;
    }
    const detected = Date.now();
    const control = describe(found);
    if (found.frame === undefined) {
      continue;
    }
    if ((attempts.get(control) ?? 0) >= closeAttempts) {
      round.log(
        `popup control ${control} resisted ${closeAttempts} attempts, giving up`,
      );
      return;
    }
    attempts.set(control, (attempts.get(control) ?? 0) + 1);
    const [x, y, width, height] = found.frame;
    const limit = large
      ? largeCloseSize
      : { width: closeSize, height: closeSize };
    if (swipe === undefined && (width > limit.width || height > limit.height)) {
      round.log(`popup control ${control} is too large to tap`);
      return;
    }
    const point = centerOf(found.frame);
    const acting = Date.now();
    if (swipe === undefined) {
      try {
        await accessibility.tap(found, {
          timeoutMs: Math.max(popupWindowMs - (Date.now() - shownAt), 0),
          signal: round.signal,
        });
      } catch (error) {
        if ((error as Error).name !== "TimeoutError") {
          throw error;
        }
        round.log(
          `popup control ${control} cannot be tapped: ${(error as Error).message}`,
        );
        continue;
      }
    } else {
      const { width: screenWidth, height: screenHeight } = round.screenSize;
      const target: Point =
        swipe === "left"
          ? [Math.max(0, x - width), point[1]]
          : swipe === "right"
            ? [Math.min(screenWidth - 1, x + width * 2), point[1]]
            : swipe === "up"
              ? [point[0], Math.max(0, y - height)]
              : [point[0], Math.min(screenHeight - 1, y + height * 2)];
      await input.swipe(point, target, {
        durationMs: swipeMs,
        signal: round.signal,
      });
    }
    const tapMs = Date.now() - acting;
    round.log(
      `${swipe === undefined ? "tapped" : `swiped ${swipe}`} popup control ${control} at [${point.map(Math.round)}]`,
    );
    if (
      (await controlAfterTap(
        selectors,
        (still) => describe(still) === control,
        round.signal,
      )) !== null
    ) {
      round.log(`popup control ${control} is still there`);
      continue;
    }
    closed++;
    await appendRecord({
      time: acting,
      app: round.app,
      fuzzy: !Object.hasOwn(closeRules, round.app),
      quick: false,
      ms: acting - round.launched,
      text: found.label ?? found.class ?? "",
      kind: "close",
      detected: detected - round.launched,
      tapMs,
      gone: Date.now() - round.launched,
    });
  }
};

const retryWhileUnavailable = async (
  round: Round,
  windowStart: number,
  windowMs: number,
  attempt: () => Promise<void>,
) => {
  while (!round.signal.aborted) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (
        (error as Error).name !== "UnavailableError" ||
        Date.now() - windowStart > windowMs
      ) {
        throw error;
      }
      console.warn(`${round.app}: the tree is unavailable, retrying`, error);
    }
  }
};

const runRound = async (
  app: string,
  pid: number,
  launched: number,
  settings: { fuzzySkip: boolean; closePopups: boolean },
  screenSize: ScreenSize,
  shown: Promise<number>,
  signal: AbortSignal,
) => {
  const started = Date.now();
  const fuzzy = !Object.hasOwn(rules, app);
  const skipped = new AbortController();
  const round: Round = {
    app,
    launched,
    started,
    screenSize,
    fuzzy,
    selectors: [
      ...(fuzzy ? sdkRules : rules[app].flat()),
      // Generic fallbacks apply to every app, not only fuzzy ones: the official
      // table is class-based and misses apps that expose no view class at all.
      ...genericRules,
    ].map((rule) => ({
      ...rule,
      app,
      not: rewarded,
    })),
    learned: await readControls(app),
    signal,
    skipping: AbortSignal.any([signal, skipped.signal]),
    taps: new Set(),
    skipped: () => skipped.abort(),
    log: (message) =>
      console.debug(`${app} pid ${pid} +${Date.now() - started}ms: ${message}`),
  };
  const closes: Close[] = (
    !settings.closePopups
      ? []
      : Object.hasOwn(closeRules, app)
        ? closeRules[app].flat()
        : fuzzy
          ? sdkCloseRules
          : []
  ).map((rule) => ({ ...rule, app, not: rewarded }));
  const popupGroups = new Map<string, Close[]>();
  for (const rule of closes) {
    const key = `${rule.swipe ?? ""}/${rule.large === true}`;
    popupGroups.set(key, [...(popupGroups.get(key) ?? []), rule]);
  }
  round.log(`round started with ${round.learned.length} learned controls`);
  try {
    const shownAt = await shown;
    const skips =
      fuzzy && !settings.fuzzySkip
        ? []
        : [
            ...(round.learned.length > 0 && !captureWarningApps.has(app)
              ? [skipOnScreen(round)]
              : []),
            retryWhileUnavailable(round, started, adWindowMs, () =>
              skipByAccessibility(round),
            ),
          ];
    await Promise.all([
      ...skips.map((skip) =>
        skip.catch((error: Error) => {
          if (error.name !== "AbortError") {
            console.warn(`${app} pid ${pid}: skipping the ad failed`, error);
          }
        }),
      ),
      ...[...popupGroups.values()].map((candidates) =>
        retryWhileUnavailable(round, shownAt, popupWindowMs, () =>
          closePopups(round, shownAt, candidates),
        ),
      ),
    ]);
  } finally {
    round.log("round ended");
  }
};

export default defineExtension({
  async run({ signal }) {
    const { screen: screenSize } = await device.info({ signal });
    const rounds = new Map<
      string,
      {
        pid: number;
        controller: AbortController;
        shown: (time: number) => void;
      }
    >();
    for await (const event of device.applicationEvents({ signal })) {
      if (ownApps.test(event.bundleId)) {
        continue;
      }
      console.debug(
        `${event.bundleId} pid ${event.pid}: ${event.type}, delivered ${Date.now() - event.time}ms after the event`,
      );
      const running = rounds.get(event.bundleId);
      if (event.type === "background") {
        if (running?.pid === event.pid) {
          running.controller.abort();
          rounds.delete(event.bundleId);
        }
        continue;
      }
      if (running?.pid === event.pid) {
        if (event.type === "foreground") {
          running.shown(event.time);
        }
        continue;
      }
      const settings = await readSettings();
      if (
        settings.disabledApps.includes(event.bundleId) ||
        (!settings.fuzzySkip &&
          !Object.hasOwn(rules, event.bundleId) &&
          !(settings.closePopups && Object.hasOwn(closeRules, event.bundleId)))
      ) {
        continue;
      }
      running?.controller.abort();
      const controller = new AbortController();
      let shown!: (time: number) => void;
      const onScreen = new Promise<number>((resolve) => {
        shown = resolve;
      });
      if (event.type === "foreground") {
        shown(event.time);
      }
      rounds.set(event.bundleId, { pid: event.pid, controller, shown });
      runRound(
        event.bundleId,
        event.pid,
        event.time,
        settings,
        screenSize,
        onScreen,
        AbortSignal.any([signal, controller.signal]),
      ).catch((error: Error) => {
        if (error.name !== "AbortError") {
          console.error(event.bundleId, error);
        }
      });
    }
  },
  actions: {
    supportedApps: defineAction({
      title: "List Supported Apps",
      async run(_, { signal }) {
        const installed = (
          await device.installedApplications({ signal })
        ).filter(
          (app) =>
            Object.hasOwn(rules, app.bundleId) ||
            Object.hasOwn(closeRules, app.bundleId),
        );
        const apps: SupportedApp[] = await Promise.all(
          installed.map(async ({ bundleId, name, version }) => ({
            bundleId,
            name,
            version,
            icon: (await device.applicationIcon(bundleId, { signal })).uri,
          })),
        );
        apps.sort((first, second) => first.name.localeCompare(second.name));
        return apps;
      },
    }),
    recordedApps: defineAction({
      title: "List Recorded Apps",
      async run(_, { signal }) {
        const installed = await device.installedApplications({ signal });
        return Promise.all(
          (await recordedApps()).map(async (bundleId): Promise<RecordedApp> => {
            const app = installed.find((it) => it.bundleId === bundleId);
            return {
              bundleId,
              name: app?.name ?? bundleId,
              icon:
                app === undefined
                  ? undefined
                  : (await device.applicationIcon(bundleId, { signal })).uri,
            };
          }),
        );
      },
    }),
  },
});
