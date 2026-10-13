/**
 * 02A05 traction sound (TKQ506B-2000 IGBT-VVVF, 纵横机电): where in two
 * recordings the inverter runs at a given stator frequency.
 *
 * The recordings are electromagnetic pick-ups of a Line 2 train (Bilibili
 * BV1VGZiBPEjt, p02), supplied by the user: one complete start under power
 * (p02 6.2–39.6 s → traction.mp3) and one complete electric-brake stop
 * (p02 66.0–96.8 s → brake.mp3). They are third-party material and are not in
 * the repository (public/sounds/vvvf/ is git-ignored); without them the sound
 * stays silent. The tables below are measurements of those files.
 *
 * Stator fundamental f₁ (the low line in the spectrogram) tracked with a 0.8 s
 * window, avoiding the 50 / 100 Hz mains lines; monotonic-smoothed. Below
 * ~25 Hz the fundamental is too weak to track: the start is taken from the
 * spacing of the asynchronous-PWM sidebands (fc ± f₁: 40 Hz apart at 12 s,
 * 85 Hz at 17.5 s → ~4 Hz/s) back to zero at 6.6 s, the tail of the brake
 * from its constant slope (3.9 Hz/s) to a stand.
 *
 * Speed ↔ f₁ 【假设】: 4-pole motors, gear ratio ≈6.3, 840 mm wheels →
 * f₁ ≈ 4.77 Hz per m/s (106 Hz at 80 km/h), slip ignored. Consistent with the
 * recordings: their slopes are 0.84 m/s² under power and 0.78 m/s² braking,
 * an ATO start and a service brake. The recordings reach ~94 Hz (≈70 km/h);
 * above that the end of the run is held.
 */
export const VVVF_HZ_PER_MS = 4.77;

/** [seconds into traction.mp3, f₁ Hz], f₁ rising */
export const VVVF_TRACTION: [number, number][] = [
  [0.2, 0], [1.2, 2], [5.8, 20], [8.8, 30.8], [9.8, 35.3], [10.8, 39.7], [11.8, 44.1], [12.8, 47.5],
  [13.8, 52.8], [14.8, 57.3], [15.8, 61.6], [16.8, 65.5], [17.8, 69.2], [18.8, 72.7], [19.8, 75.3],
  [20.8, 77], [21.8, 78.3], [22.8, 79.1], [23.8, 80.6], [24.8, 83.3], [25.8, 85.8], [26.8, 88.1],
  [27.8, 90.3], [28.8, 92], [29.8, 93], [33.2, 93.8],
];

/** [seconds into brake.mp3, f₁ Hz], f₁ falling; 0–8 s is a steady stretch before the brake */
export const VVVF_BRAKE: [number, number][] = [
  [0, 81.6], [1, 80.9], [4, 80.8], [8, 80.5], [9, 78.9], [10, 76.7], [11, 73.4], [12, 70], [13, 66.4],
  [14, 62.7], [15, 58.9], [16, 55.2], [17, 51.6], [18, 47.7], [19, 43.4], [20, 39.7], [21, 35.6],
  [22, 31.9], [23, 27.7], [30.1, 0],
];
