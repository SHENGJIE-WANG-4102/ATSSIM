/**
 * User's local Line 2 recordings, supplied on 2026-10-14.
 * Source files live in ignored work/recordings/; no audio or passenger
 * transcript is distributed. Filename door references are car-door numbers:
 * westbound 4-1, eastbound 5-5. The user says clock start times are unknown;
 * filesystem copy times must not be used as recording times.
 *
 * Method: local speech recognition locates station announcements; 8 kHz
 * spectrograms (256 ms windows / 64 ms hops) locate recurring ~2750 / 2843 Hz
 * closing-tone pulses and rising traction bands. Stops are estimated by
 * measure-stops.py (512 ms windows / 64 ms hops): descending brake ridges,
 * followed by a 20-400 Hz energy
 * knee near the local noise floor. Tools cannot accept audio input; automatic
 * estimates therefore carry evidence-based high/medium/low confidence.
 * Speech timestamps are not door times;
 * "门灯闪烁时，请勿上下车" is also part of arrival announcements.
 *
 * User decision superseding the handoff: +/-3 s is adequate; adopt closing
 * and starting candidates, omit opening times, exclude low-confidence events
 * from averages. Search windows are analysis bounds, not event bounds.
 * Confidence thresholds and frequency templates are assumptions 【假设】;
 * they are not statistical error bars. User-supplied markers retain decimals.
 * Station order/names: line2.ts; official comparison: firstlast.ts.
 */
export type RideDirection = 'DN' | 'UP';
export type RecordingId = 'ride-east' | 'ride-west' | 'platform-01' | 'platform-03';
export const RIDELOG_PRECISION_S = 3;

export interface RecordingSource {
  id: RecordingId;
  filename: string;
  kind: 'ride' | 'platform';
  durationS: number;
  clockStart: string | null;
  from: string;
  to: string;
  directions: RideDirection[];
  /** Filename references; these do not establish microphone proximity. */
  doorReferences?: { direction: RideDirection; car: number; door: number; trainType: string }[];
}

export const RECORDING_SOURCES: RecordingSource[] = [
  { id: 'ride-east', filename: '2号线江苏路~广兰路 终点站广兰路小交路02A05 020897.wav',
    kind: 'ride', durationS: 2311.66, clockStart: null, from: '江苏路', to: '广兰路', directions: ['DN'] },
  { id: 'ride-west', filename: '广兰路~金科路小交路.wav',
    kind: 'ride', durationS: 148.2, clockStart: null, from: '广兰路', to: '金科路', directions: ['UP'] },
  { id: 'platform-01', filename: '江苏路2号线SNAI 02A01 4-1 PVG 02A05 5-5.wav',
    kind: 'platform', durationS: 133.32, clockStart: null, from: '江苏路', to: '江苏路', directions: ['UP', 'DN'],
    doorReferences: [{ direction: 'UP', car: 4, door: 1, trainType: '02A01' },
      { direction: 'DN', car: 5, door: 5, trainType: '02A05' }] },
  { id: 'platform-03', filename: '江苏路2号线SNAI 02A03 4-1 PVG 02A05 5-5.wav',
    kind: 'platform', durationS: 109.96, clockStart: null, from: '江苏路', to: '江苏路', directions: ['UP', 'DN'],
    doorReferences: [{ direction: 'UP', car: 4, door: 1, trainType: '02A03' },
      { direction: 'DN', car: 5, door: 5, trainType: '02A05' }] },
];

export interface AcousticCandidate {
  /** Seconds in the original file, not a sliced/concatenated audio stream. */
  at: number;
  /** Search tolerance 【假设】; must not be advertised as verified accuracy. */
  searchRadiusS: number;
  evidence: 'closing-tone-pulses' | 'rising-traction-band';
}

export type RideConfidence = 'high' | 'medium' | 'low';
export interface RideEventEvidence {
  confidence: RideConfidence;
  method: 'spectral-knee' | 'closing-tone-pulses' | 'rising-traction-band' | 'user-marker' | 'file-boundary';
  /** Descending ridge band, not a speed or chainage estimate. */
  bandHz?: [number, number];
  ridgeFallDb?: number;
  lowBeforeDb?: number;
  lowAfterDb?: number;
  lowFallDb?: number;
  floorDb?: number;
  ambiguous?: boolean;
  /** Keep the independent automatic estimate when a user marker overrides it. */
  autoAt?: number;
  note?: string;
}

export interface RideStop {
  recording: RecordingId;
  station: string;
  direction: RideDirection;
  /** Adopted events in original recording seconds; null means not captured. */
  stop: number | null;
  open: number | null;
  close: number | null;
  start: number | null;
  evidence: { stop?: RideEventEvidence; close?: RideEventEvidence; start?: RideEventEvidence };
  candidates: { close?: AcousticCandidate; start?: AcousticCandidate };
  /** Bounds for automated arrival analysis, not a request for user review. */
  analysisWindowS: [number, number] | null;
  note?: string;
}

const tone = (at: number): AcousticCandidate => ({ at, searchRadiusS: 1, evidence: 'closing-tone-pulses' });
const traction = (at: number): AcousticCandidate => ({ at, searchRadiusS: 3, evidence: 'rising-traction-band' });
const east = (station: string, analysisWindowS: [number, number] | null,
  close: number | null, start: number | null, note?: string): RideStop => ({
  recording: 'ride-east', station, direction: 'DN', stop: null, open: null, close, start,
  evidence: { ...(close === null ? {} : { close: { confidence: 'high' as const, method: 'closing-tone-pulses' as const } }),
    ...(start === null ? {} : { start: { confidence: 'medium' as const, method: 'rising-traction-band' as const } }) },
  candidates: { ...(close === null ? {} : { close: tone(close) }), ...(start === null ? {} : { start: traction(start) }) },
  analysisWindowS, ...(note ? { note } : {}),
});

export const RIDE_LOG: RideStop[] = [
  east('江苏路', null, null, 8, 'Recording starts during the closing tones; their onset is not captured.'),
  east('静安寺', [88, 132], 164, 174),
  east('南京西路', [261, 305], 375, 386),
  east('人民广场', [466, 510], 540, 553),
  east('南京东路', [617, 663], 693, 706),
  east('陆家嘴', [807, 852], 884, 894),
  east('浦东南路', [973, 1017], 1072, 1083),
  east('世纪大道', [1149, 1224], 1225, 1240, 'Multiple tonal/broadband changes; motion and door sounds need separation.'),
  east('上海科技馆', [1330, 1381], 1429, 1442),
  east('世纪公园', [1525, 1570], 1588, 1600),
  east('龙阳路', [1658, 1705], 1735, 1750),
  east('张江高科', [1915, 1965], 1980, 1993),
  east('金科路', [2064, 2124], 2141, 2148),
  east('广兰路', [2265, 2311.66], null, null, 'Terminating service; no onward departure is established.'),
  { recording: 'ride-west', station: '广兰路', direction: 'UP', stop: null, open: null, close: null, start: null,
    candidates: {}, evidence: {}, analysisWindowS: null, note: 'Traction is present at the file boundary; the start onset is not fully captured.' },
  { recording: 'ride-west', station: '金科路', direction: 'UP', stop: null, open: null, close: null, start: null,
    candidates: {}, evidence: {}, analysisWindowS: [115, 148.2], note: 'Recording ends near a falling traction band; post-stop context is limited.' },
];

// Only 3.2 s of post-stop context in this short file; excluded from averages.
const shortArrival = RIDE_LOG.find(row => row.recording === 'ride-west' && row.station === '金科路')!;
shortArrival.stop = 145;
shortArrival.evidence.stop = { confidence: 'low', method: 'spectral-knee', bandHz: [650, 900],
  ridgeFallDb: 13.04, lowBeforeDb: -25.76, lowAfterDb: -26, lowFallDb: .24, floorDb: -26.05,
  ambiguous: false, note: 'File ends at 148.20 s; stop context is edge-limited and start is not captured.' };

/** Output of measure-stops.py; the frequency/energy numbers explain each decision. */
export const BRAKE_STOP_MEASUREMENTS: (RideEventEvidence & { station: string; at: number })[] = [
  { station: '静安寺', at: 125, confidence: 'high', bandHz: [600, 900], ridgeFallDb: 7.17, lowBeforeDb: -21.81, lowAfterDb: -23.16, lowFallDb: 1.34, floorDb: -22.86, ambiguous: false },
  { station: '南京西路', at: 299, confidence: 'medium', bandHz: [600, 900], ridgeFallDb: 5.77, lowBeforeDb: -21.75, lowAfterDb: -23.12, lowFallDb: 1.37, floorDb: -23.05, ambiguous: false },
  { station: '人民广场', at: 500, confidence: 'medium', bandHz: [600, 900], ridgeFallDb: 7.71, lowBeforeDb: -21.83, lowAfterDb: -23.14, lowFallDb: 1.31, floorDb: -22.8, ambiguous: false },
  { station: '南京东路', at: 659, confidence: 'low', bandHz: [600, 900], ridgeFallDb: 3.38, lowBeforeDb: -19.22, lowAfterDb: -22.92, lowFallDb: 3.7, floorDb: -26.3, ambiguous: true },
  { station: '陆家嘴', at: 843, confidence: 'medium', bandHz: [550, 900], ridgeFallDb: 3, lowBeforeDb: -25.72, lowAfterDb: -26.31, lowFallDb: 0.58, floorDb: -26.43, ambiguous: false },
  { station: '浦东南路', at: 1008, confidence: 'low', bandHz: [550, 900], ridgeFallDb: 2.71, lowBeforeDb: -21.97, lowAfterDb: -24.04, lowFallDb: 2.08, floorDb: -24.79, ambiguous: true },
  { station: '世纪大道', at: 1168, confidence: 'low', bandHz: [650, 900], ridgeFallDb: 4.43, lowBeforeDb: -14.82, lowAfterDb: -20.1, lowFallDb: 5.28, floorDb: -20.44, ambiguous: true },
  { station: '上海科技馆', at: 1369, confidence: 'medium', bandHz: [650, 900], ridgeFallDb: 6.93, lowBeforeDb: -26.03, lowAfterDb: -25.63, lowFallDb: -0.4, floorDb: -25.95, ambiguous: false },
  { station: '世纪公园', at: 1585, confidence: 'low', bandHz: [550, 960], ridgeFallDb: 3.97, lowBeforeDb: -21.99, lowAfterDb: -23.06, lowFallDb: 1.07, floorDb: -22.99, ambiguous: true },
  { station: '龙阳路', at: 1692, confidence: 'high', bandHz: [600, 900], ridgeFallDb: 10.66, lowBeforeDb: -26.8, lowAfterDb: -27.46, lowFallDb: 0.65, floorDb: -27.27, ambiguous: false },
  { station: '张江高科', at: 1951, confidence: 'medium', bandHz: [650, 900], ridgeFallDb: 3.47, lowBeforeDb: -21.81, lowAfterDb: -25.45, lowFallDb: 3.65, floorDb: -25.09, ambiguous: false },
  { station: '金科路', at: 2134, confidence: 'low', bandHz: [600, 900], ridgeFallDb: 4.87, lowBeforeDb: -23.88, lowAfterDb: -25.56, lowFallDb: 1.68, floorDb: -25.58, ambiguous: true },
  { station: '广兰路', at: 2303, confidence: 'high', bandHz: [650, 900], ridgeFallDb: 8.15, lowBeforeDb: -18.77, lowAfterDb: -28.17, lowFallDb: 9.4, floorDb: -28.43, ambiguous: false },
].map(row => ({ ...row, method: 'spectral-knee' as const, confidence: row.confidence as RideConfidence,
  bandHz: row.bandHz as [number, number] }));

for (const measured of BRAKE_STOP_MEASUREMENTS) {
  const row = RIDE_LOG.find(entry => entry.recording === 'ride-east' && entry.station === measured.station)!;
  row.stop = measured.at;
  row.evidence.stop = { ...measured };
}

/** Direct user decisions override automatic estimates; retain the estimate for comparison. */
export const USER_RIDE_MARKERS: { station: string; event: 'stop' | 'close' | 'start'; at: number }[] = [
  { station: '静安寺', event: 'stop', at: 126 },
  { station: '静安寺', event: 'close', at: 164.5 },
  { station: '南京东路', event: 'close', at: 693.28 },
  { station: '南京东路', event: 'start', at: 705.55 },
  { station: '陆家嘴', event: 'stop', at: 845.55 },
  { station: '龙阳路', event: 'close', at: 1735.16 },
];
for (const marker of USER_RIDE_MARKERS) {
  const row = RIDE_LOG.find(entry => entry.recording === 'ride-east' && entry.station === marker.station)!;
  const automatic = row[marker.event];
  row[marker.event] = marker.at;
  row.evidence[marker.event] = { ...row.evidence[marker.event], confidence: 'high', method: 'user-marker',
    ...(automatic === null ? {} : { autoAt: automatic }), note: 'User-provided recording timestamp.' };
}

/** Additional user door observations, including the corrected lock timestamp. */
export const USER_DOOR_REFERENCES = {
  recording: 'ride-east' as RecordingId, station: '静安寺',
  open: 127.5, closingMotion: 167.2,
  locked: { raw: '2.50.20', parsedSeconds: 170.2, usable: true },
};

/** Immutable pre-calibration plan snapshot, generated before concurrent model edits.
 * Source: weekday generatePlan/computeRunTimes at the revision below; seconds.
 * Keep the original comparison stable as calibration changes the current model.
 */
export const RIDE_MODEL_BASELINE = {
  revision: '7eead9e', tripG: '3009', tripW: '3002',
  tripAirport: '1433', airportFullSeconds: 4591.03,
  wholeRecordedModelSeconds: 1702.25,
  terminalDN: '广兰路', terminalUP: '蟠祥路·国家会计学院',
  intervals: [
    { direction: 'DN', from: '江苏路', to: '静安寺', runS: 103.5, dwellS: 25.53 },
    { direction: 'DN', from: '静安寺', to: '南京西路', runS: 102.6, dwellS: 25.51 },
    { direction: 'DN', from: '南京西路', to: '人民广场', runS: 94.9, dwellS: 25.66 },
    { direction: 'DN', from: '人民广场', to: '南京东路', runS: 86.4, dwellS: 25.51 },
    { direction: 'DN', from: '南京东路', to: '陆家嘴', runS: 131.9, dwellS: 25.49 },
    { direction: 'DN', from: '陆家嘴', to: '浦东南路', runS: 104.9, dwellS: 20.3 },
    { direction: 'DN', from: '浦东南路', to: '世纪大道', runS: 90.8, dwellS: 25.57 },
    { direction: 'DN', from: '世纪大道', to: '上海科技馆', runS: 117.9, dwellS: 20.22 },
    { direction: 'DN', from: '上海科技馆', to: '世纪公园', runS: 100.9, dwellS: 20.21 },
    { direction: 'DN', from: '世纪公园', to: '龙阳路', runS: 87.9, dwellS: 25.36 },
    { direction: 'DN', from: '龙阳路', to: '张江高科', runS: 172.1, dwellS: 20.29 },
    { direction: 'DN', from: '张江高科', to: '金科路', runS: 98, dwellS: 20.21 },
    { direction: 'DN', from: '金科路', to: '广兰路', runS: 130.6, dwellS: 0 },
    { direction: 'UP', from: '广兰路', to: '金科路', runS: 130.5, dwellS: 20.22 },
  ],
};

/** User markers in the long eastbound file; chainage conversion is a separate task. */
export const PORTAL_REVIEW = {
  recording: 'ride-east' as RecordingId,
  direction: 'DN' as RideDirection,
  from: '龙阳路', to: '张江高科',
  reviewS: [1790, 1910] as [number, number],
  exitTunnel: 1815.21, enterTunnel: 1840.71,
  confidence: 'high' as RideConfidence,
  method: 'user-marker' as const,
  note: '25.50 s exposed. The westbound file ends before this section; no chainage inferred.',
};
