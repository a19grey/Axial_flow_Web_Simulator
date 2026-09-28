/* Scoring a design rather than an operating point.
 *
 * A single solve returns a torque at whatever rotor angle and current phase the spec happened to
 * name. That is not a property of the design — it is a property of the design *and* an arbitrary
 * operating point, and ranking designs by it ranks the spec author's guesses. Putting every design
 * at its own best operating point is the first requirement of any search over geometry.
 *
 * It costs three solves per rotor angle, and nothing after that, because with linear materials the
 * whole operating point is arithmetic:
 *
 *   div(mu grad phi) = div(mu Hs),  B = mu0 mu (Hs - grad phi)
 *
 * is linear in the source currents, so three solves at unit current in each phase give B_1, B_2,
 * B_3 and the field at *any* current vector is exactly I_1 B_1 + I_2 B_2 + I_3 B_3. Maxwell stress
 * is quadratic in B, so torque is a quadratic form in the current vector,
 *
 *   T(I) = I^T Q I,   Q_jk = 1/2 [ T(e_j + e_k) - T(e_j) - T(e_k) ]
 *
 * and Q costs six evaluations of the *existing* stress integrator over fields already solved: no
 * GPU work, no new physics, no new integrator. Substituting the balanced three-phase set
 * I_k = A cos(phi - 2 pi k / 3) with phi = (P/2) theta + gamma leaves only a constant and a 2 phi
 * term, so
 *
 *   T(gamma) / A^2 = c0 + 1/2 ( C cos 2 phi + S sin 2 phi )      exactly,
 *
 * whose peak is closed form. The optimal current phase is not searched for, it is computed; the
 * current amplitude that hits a copper-loss budget is closed form too, because loss goes as A^2 and
 * so does torque. Both stop being design variables and come out of the evaluation instead.
 *
 * Superposition holds because mu does not depend on the field. It will stop holding the day
 * nonlinear steel lands, so every scored design ends with one confirming solve at the computed
 * optimum and reports how far the prediction missed. Agreement to a fraction of a percent is the
 * evidence the quadratic form is exact. Disagreement is a loud number in the record rather than a
 * silent wrong answer.
 *
 * Rotor angle is not symmetric with current phase: moving the rotor changes the geometry, so
 * nothing superposes and each angle costs its own three solves. It is also scored differently —
 * the *mean* over the ripple period, not the peak. A motor under load passes through every rotor
 * angle, so what it delivers is the mean; scoring the peak would hand the best score to the design
 * with the worst ripple. The mean is cheap because of the harmonic structure: three samples spaced
 * 120/P mechanical degrees apart cancel the 6th and 12th electrical harmonics exactly and alias
 * only the 18th. (The 8-pole demo's measured 15-degree torque period is exactly this 120/P.)
 */

import { normalizeSpec, specToParams, specHash } from "../core/spec.js";
import { buildMotor } from "../core/geometry.js";
import { solveJob } from "../core/solve.js";
import { motorMetrics } from "../core/torque.js";
import { windingGeometry, airgapShear } from "../core/metrics.js";
import { resultsSummary } from "../core/results.js";

const DEG = Math.PI / 180;
const TWO_THIRDS_PI = 2 * Math.PI / 3;

/* How many rotor angles each tier averages over, and whether it pays for the confirming solve.
 *
 * "screen" is for ranking hundreds of designs against each other, where a common rotor angle is a
 * fair comparison even though it is not the mean. "score" is the real number. "confirm" oversamples
 * the ripple period so the three-sample mean can be checked against a dense one. */
export const TIERS = {
  /* Even the screening tier pays for the confirming solve. Three unit-current solves give a torque
   * but no results JSON, and a design with no results JSON has no quality flags, no peak B, no mass
   * and no check that superposition held — so a gate that reads them would silently pass. One extra
   * solve in four buys every gate on every design, which is a third more time for the difference
   * between a ranking and a guess. */
  screen:  { angles: 1, confirm: true },
  score:   { angles: 3, confirm: true },
  confirm: { angles: 12, confirm: true }
};

/* ---- the quadratic form ----------------------------------------------------------------------- */

/* Torque of a superposed field, without another solve.
 *
 * The three per-phase fields are CPU arrays by the time they get here, so combining them is a pass
 * over memory rather than anything on the device. `motorMetrics` reads only `sol.job` and the three
 * B components, which is what makes a synthetic solution legitimate to hand it. */
function superpose(job, basis, I, scratch) {
  const N = basis[0].Bx.length;
  const Bx = scratch.Bx, By = scratch.By, Bz = scratch.Bz;
  Bx.fill(0); By.fill(0); Bz.fill(0);
  for (let k = 0; k < 3; k++) {
    const c = I[k];
    if (c === 0) continue;
    const b = basis[k];
    for (let i = 0; i < N; i++) { Bx[i] += c * b.Bx[i]; By[i] += c * b.By[i]; Bz[i] += c * b.Bz[i]; }
  }
  return { job, Bx, By, Bz };
}

/* Q_jk from six stress evaluations. Symmetric by construction, which is also a check: the stress
 * integrator is a quadratic form in B whether or not it was written to be one, and a Q that fails
 * to reproduce a direct evaluation would say it is not. */
function quadraticForm(job, basis, scratch) {
  const T = I => motorMetrics(superpose(job, basis, I, scratch)).torque;
  const d = [T([1, 0, 0]), T([0, 1, 0]), T([0, 0, 1])];
  const Q = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let j = 0; j < 3; j++) Q[j][j] = d[j];
  for (const [j, k] of [[0, 1], [0, 2], [1, 2]]) {
    const I = [0, 0, 0]; I[j] = 1; I[k] = 1;
    // The pair contributes twice in I^T Q I, so T(e_j + e_k) = Q_jj + Q_kk + 2 Q_jk.
    Q[j][k] = Q[k][j] = 0.5 * (T(I) - d[j] - d[k]);
  }
  return Q;
}

/* The three coefficients of the exact torque-versus-current-phase curve at one rotor angle.
 *
 *   T(A, phi) = A^2 [ c0 + 1/2 ( C cos 2 phi + S sin 2 phi ) ]
 *
 * from I_j I_k = 1/2 [ cos(2 phi - 2 pi (j+k)/3) + cos(2 pi (j-k)/3) ]. */
export function phaseCoefficients(Q) {
  let c0 = 0, C = 0, S = 0;
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
    const q = Q[j][k];
    c0 += 0.5 * q * Math.cos(TWO_THIRDS_PI * (j - k));
    C += q * Math.cos(TWO_THIRDS_PI * (j + k));
    S += q * Math.sin(TWO_THIRDS_PI * (j + k));
  }
  return { c0, C, S };
}

/* Torque at unit current amplitude, from the coefficients alone. */
export const torqueAt = ({ c0, C, S }, phi) => c0 + 0.5 * (C * Math.cos(2 * phi) + S * Math.sin(2 * phi));

/* The current phase that maximizes the *mean* over the sampled rotor angles.
 *
 * Each angle contributes its own Q, and phi = eps_i + gamma with eps_i = (P/2) theta_i fixed, so the
 * mean is still exactly `a + b cos 2 gamma + d sin 2 gamma` and its peak is 1/2 atan2(d, b). The
 * per-angle coefficients differ, which is why the 2 phi term survives the average at all: if C and S
 * were angle-independent the three samples would cancel it and gamma would not matter.
 *
 * The period in gamma is 180 electrical degrees, because negating every current leaves a quadratic
 * form unchanged. */
export function optimalPhase(coeffs, eps) {
  let a = 0, b = 0, d = 0;
  for (let i = 0; i < coeffs.length; i++) {
    const { c0, C, S } = coeffs[i], e2 = 2 * eps[i];
    a += c0;
    b += 0.5 * (C * Math.cos(e2) + S * Math.sin(e2));
    d += 0.5 * (S * Math.cos(e2) - C * Math.sin(e2));
  }
  const n = coeffs.length;
  a /= n; b /= n; d /= n;
  let gamma = 0.5 * Math.atan2(d, b);
  if (!Number.isFinite(gamma)) gamma = 0;
  while (gamma < 0) gamma += Math.PI;
  while (gamma >= Math.PI) gamma -= Math.PI;
  return {
    gamma,
    meanAtGamma: a + b * Math.cos(2 * gamma) + d * Math.sin(2 * gamma),
    meanFlat: a,
    /* How much the current phase is worth at all. Zero means the machine has no saliency the
     * currents can exploit at these angles, and gamma is then arbitrary rather than optimal. */
    amplitude: Math.hypot(b, d)
  };
}

/* ---- the evaluator ----------------------------------------------------------------------------- */

/* Score one design.
 *
 *   evaluateDesign(spec, { tier: "score", lossBudget_W: 1.2 })
 *
 * Returns a flat record: the operating point it chose, the mean torque and shear over the ripple
 * period, the ripple itself, the confirming solve's full results JSON, and its own cost. Nothing in
 * it is rounded — an optimizer comparing two designs a fraction of a percent apart needs every
 * digit the f32 solve produced, and the cache needs the record to be bit-reproducible. */
export async function evaluateDesign(specIn, opts = {}) {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const { spec, warnings } = normalizeSpec(specIn);
  const tier = TIERS[opts.tier] ? opts.tier : "score";
  const plan = { ...TIERS[tier], ...(opts.angles ? { angles: opts.angles } : {}) };

  const p0 = specToParams(spec);
  const poles = p0.poles;
  /* One period of the 6th electrical harmonic, which is what three-phase torque ripple mostly is.
   * Sampling evenly across exactly this window is what makes a three-sample mean meaningful. */
  const window_deg = 120 / poles;
  const theta0 = p0.theta;
  const angles = [];
  for (let i = 0; i < plan.angles; i++) angles.push(theta0 + window_deg * i / plan.angles);

  let scratch = null, R = null, shearPerNm = null, solves = 0;
  const coeffs = [], eps = [];

  for (let i = 0; i < angles.length; i++) {
    if (opts.signal?.aborted) throw new Error("evaluation aborted");
    const p = specToParams({ ...spec, operatingPoint: { ...spec.operatingPoint, rotorAngle_deg: angles[i] } });
    const job = buildMotor(p);
    const basis = [];
    for (let k = 0; k < 3; k++) {
      opts.onProgress && opts.onProgress({ phase: "operatingPoint", index: i * 3 + k, total: angles.length * 3, angle_deg: angles[i], basis: k });
      const I = [0, 0, 0]; I[k] = 1;
      const sol = await solveJob(job, { ...opts, currents: I, solver: spec.solver });
      solves++;
      basis.push({ Bx: sol.Bx, By: sol.By, Bz: sol.Bz });
      if (!scratch || scratch.Bx.length !== sol.Bx.length) scratch = {
        Bx: new Float32Array(sol.Bx.length), By: new Float32Array(sol.Bx.length), Bz: new Float32Array(sol.Bx.length)
      };
      if (k === 0 && i === 0) {
        R = windingGeometry(job).phaseResistance_ohm;
        /* Shear stress is torque over the r-weighted swept area, which is pure geometry: read the
         * ratio once from a field that happens to be in hand and scale every torque by it. */
        const probe = { job, Bx: sol.Bx, By: sol.By, Bz: sol.Bz };
        probe.m = motorMetrics(probe);
        const sh = airgapShear(probe);
        shearPerNm = probe.m.torque && sh.kPa !== null ? sh.kPa / probe.m.torque : null;
      }
    }
    coeffs.push(phaseCoefficients(quadraticForm(job, basis, scratch)));
    eps.push((poles / 2) * angles[i] * DEG);
  }

  /* The current amplitude that spends exactly the loss budget. Copper loss is
   * sum_k (A/sqrt2)^2 R_k, so A = sqrt(2 P / sum R) — and torque goes as A^2, so the whole
   * amplitude question is one square root rather than a sweep. */
  const sumR = R ? R.reduce((a, r) => a + r, 0) : 0;
  const budget_W = Number.isFinite(opts.lossBudget_W) ? +opts.lossBudget_W
    : 0.5 * p0.amps * p0.amps * sumR;                                  // the baseline's own loss
  const amps = sumR > 0 && budget_W > 0 ? Math.sqrt(2 * budget_W / sumR) : p0.amps;

  const best = optimalPhase(coeffs, eps);
  const gamma_deg = best.gamma / DEG;
  const A2 = amps * amps;
  const perAngle = coeffs.map((c, i) => A2 * torqueAt(c, eps[i] + best.gamma));
  const mean = perAngle.reduce((a, b) => a + b, 0) / perAngle.length;
  const lo = Math.min(...perAngle), hi = Math.max(...perAngle);

  /* The confirming solve. Its job is to check superposition, but it also produces the one full
   * results JSON the record carries — masses, resistances, quality flags, mesh statistics — all of
   * it consistent with the operating point that was chosen rather than with the one that was
   * typed. */
  let confirm = null, results = null;
  if (plan.confirm !== false && opts.confirm !== false) {
    const cspec = {
      ...spec,
      design: { ...spec.design, stator: { ...spec.design.stator, peakCurrent_A: amps } },
      operatingPoint: { ...spec.operatingPoint, rotorAngle_deg: angles[0], currentAngle_elecDeg: gamma_deg }
    };
    const p = specToParams(cspec);
    const job = buildMotor(p);
    const phi = ((poles / 2) * angles[0] + gamma_deg) * DEG;
    const I = [0, 1, 2].map(k => amps * Math.cos(phi - TWO_THIRDS_PI * k));
    opts.onProgress && opts.onProgress({ phase: "operatingPoint", index: angles.length * 3, total: angles.length * 3 + 1, angle_deg: angles[0], basis: "confirm" });
    const sol = await solveJob(job, { ...opts, currents: I, solver: cspec.solver });
    solves++;
    sol.I = I; sol.m = motorMetrics(sol); sol.spec = cspec;
    results = resultsSummary(sol);
    // Both in mN.m: the record reports millinewton-metres throughout, because the results JSON does.
    const predicted = A2 * torqueAt(coeffs[0], eps[0] + best.gamma) * 1e3;
    const measured = results.torque_mNm;
    confirm = {
      rotorAngle_deg: angles[0],
      predictedTorque_mNm: predicted,
      measuredTorque_mNm: measured,
      error_pct: measured ? (predicted - measured) / measured * 100 : null
    };
  }

  const now = (typeof performance !== "undefined" ? performance : Date).now();
  return {
    specHash: specHash(spec),
    tier,
    operatingPoint: {
      currentAngle_elecDeg: gamma_deg,
      peakCurrent_A: amps,
      copperLoss_W: 0.5 * A2 * sumR,
      copperLossBudget_W: budget_W,
      phaseResistance_ohm: R,
      /* How much of the achieved torque came from choosing the current phase, rather than being
       * there at any phase. A reluctance machine with no magnets has almost no phase-independent
       * torque, so this sits near 100 % and gamma is the whole game; a design where it is near zero
       * has no saliency the currents can exploit, and the value of gamma reported beside it is
       * arbitrary rather than optimal. Worth reading before reading anything into gamma itself. */
      phaseLeverage_pct: best.meanAtGamma ? Math.abs(best.amplitude / best.meanAtGamma) * 100 : null
    },
    ripplePeriod_deg: window_deg,
    angles_deg: angles,
    torqueAtAngles_mNm: perAngle.map(v => v * 1e3),
    meanTorque_mNm: mean * 1e3,
    minTorque_mNm: lo * 1e3,
    maxTorque_mNm: hi * 1e3,
    /* Peak-to-peak over the mean. From three samples this resolves the 6th and 12th harmonics and
     * aliases the 18th, so it is an estimate with a known blind spot rather than a measurement; the
     * confirm tier's twelve samples are what check it. From *one* sample it is not an estimate at
     * all, and reporting the zero it arithmetically comes to would be a lie about a machine whose
     * ripple is over 60 %, so a single-angle tier reports nothing. */
    ripple_pct: angles.length > 1 && mean ? (hi - lo) / Math.abs(mean) * 100 : null,
    meanShear_kPa: shearPerNm === null ? null : mean * shearPerNm,
    shearPerTorque_kPa_per_Nm: shearPerNm,
    confirm,
    results,
    warnings,
    cost: { solves, elapsed_ms: +(now - t0).toFixed(0) }
  };
}
