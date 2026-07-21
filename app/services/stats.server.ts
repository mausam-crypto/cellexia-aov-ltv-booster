/**
 * Pure statistics helpers for the sequential experiment tracker.
 *
 * Dependency-free by design (SPEC v2): the Student-t CDF is computed via the
 * regularized incomplete beta function (continued-fraction expansion) and the
 * normal CDF via a high-accuracy complementary error function approximation.
 * Everything in this module is deterministic math — no I/O, no globals.
 *
 * Degenerate inputs (samples smaller than 2, zero variance in both samples,
 * empty denominators, pooled proportions of exactly 0 or 1) return `null`
 * instead of pretending to produce a p-value — callers render those as "n/a".
 */

export interface WelchTTestResult {
  t: number;
  df: number;
  pTwoSided: number;
}

export interface TwoProportionZTestResult {
  z: number;
  pTwoSided: number;
}

/** Arithmetic mean. Empty input returns NaN. */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Unbiased (n - 1) sample variance. Fewer than 2 values returns NaN. */
export function sampleVariance(values: number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const m = mean(values);
  let sumSquares = 0;
  for (const value of values) {
    const deviation = value - m;
    sumSquares += deviation * deviation;
  }
  return sumSquares / (n - 1);
}

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

/** Lanczos approximation (g = 7, n = 9) — ~15 significant digits. */
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula keeps the approximation accurate near zero.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    series += LANCZOS_COEFFICIENTS[i] / (shifted + i);
  }
  const t = shifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(series)
  );
}

/**
 * Continued-fraction expansion of the incomplete beta function
 * (modified Lentz's method, cf. Numerical Recipes "betacf").
 * Converges quickly for x < (a + 1) / (a + b + 2).
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-14;
  const TINY = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    // Even step of the recurrence.
    let coefficient = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + coefficient / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // Odd step of the recurrence.
    coefficient = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + coefficient / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), for a > 0, b > 0, x in [0, 1]. */
export function regularizedIncompleteBeta(
  a: number,
  b: number,
  x: number,
): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return NaN;
  }
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront =
    logGamma(a + b) -
    logGamma(a) -
    logGamma(b) +
    a * Math.log(x) +
    b * Math.log(1 - x);
  const front = Math.exp(logFront);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  // Symmetry: I_x(a, b) = 1 - I_{1-x}(b, a); the mirrored fraction converges here.
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return NaN;
  return Math.min(1, Math.max(0, p));
}

/**
 * Two-sided p-value for a Student-t statistic with `df` degrees of freedom:
 * P(|T| >= |t|) = I_{df / (df + t^2)}(df / 2, 1 / 2).
 */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  const x = df / (df + t * t);
  return clampProbability(regularizedIncompleteBeta(df / 2, 0.5, x));
}

/**
 * Complementary error function (Numerical Recipes 6.2 Chebyshev fit) —
 * fractional error below 1.2e-7 everywhere, ample for p-value reporting.
 */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const value =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? value : 2 - value;
}

/** Two-sided p-value for a standard-normal statistic: P(|Z| >= |z|). */
export function normalTwoSidedP(z: number): number {
  if (!Number.isFinite(z)) return NaN;
  return clampProbability(erfc(Math.abs(z) / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Welch's unequal-variance t-test with Welch–Satterthwaite degrees of
 * freedom. `t` is signed as mean(a) - mean(b). Returns null when either
 * sample has fewer than 2 values or both samples have zero variance.
 */
export function welchTTest(
  a: number[],
  b: number[],
): WelchTTestResult | null {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) return null;
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) return null;

  const varianceA = sampleVariance(a);
  const varianceB = sampleVariance(b);
  const seSqA = varianceA / nA;
  const seSqB = varianceB / nB;
  const seSq = seSqA + seSqB;
  if (!(seSq > 0)) return null; // Zero variance in both samples — no test.

  const t = (mean(a) - mean(b)) / Math.sqrt(seSq);
  const df =
    (seSq * seSq) /
    ((seSqA * seSqA) / (nA - 1) + (seSqB * seSqB) / (nB - 1));
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;

  const pTwoSided = studentTTwoSidedP(t, df);
  if (!Number.isFinite(pTwoSided)) return null;
  return { t, df, pTwoSided };
}

/**
 * Pooled two-proportion z-test. `z` is signed as pA - pB. Returns null on
 * empty denominators, out-of-range successes, or a pooled proportion of
 * exactly 0 or 1 (zero standard error).
 */
export function twoProportionZTest(
  successA: number,
  totalA: number,
  successB: number,
  totalB: number,
): TwoProportionZTestResult | null {
  if (
    ![successA, totalA, successB, totalB].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  ) {
    return null;
  }
  if (totalA < 1 || totalB < 1) return null;
  if (successA > totalA || successB > totalB) return null;

  const pooled = (successA + successB) / (totalA + totalB);
  const standardError = Math.sqrt(
    pooled * (1 - pooled) * (1 / totalA + 1 / totalB),
  );
  if (!(standardError > 0)) return null; // Pooled proportion is 0 or 1.

  const z = (successA / totalA - successB / totalB) / standardError;
  const pTwoSided = normalTwoSidedP(z);
  if (!Number.isFinite(z) || !Number.isFinite(pTwoSided)) return null;
  return { z, pTwoSided };
}
