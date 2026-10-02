// src/helpers/gli2012.js
'use strict';

const COEFFICIENTS = require('./gli2012-coefficients.json');

const ETHNICITY_INDEX = {
  1: 0,  // Caucasian (reference — no offset)
  2: 1,  // African-American
  3: 2,  // NE Asian
  4: 3,  // SE Asian
  5: 4,  // Other/mixed
};

function round2(n) {
  return Number(n.toFixed(2));
}

/**
 * Find the two agebound rows that bracket the patient's age, and
 * linearly interpolate each coefficient between them.
 */
function interpolateRow(rows, age) {
  if (!rows || rows.length === 0) return null;
  if (age <= rows[0].age) return rows[0];
  if (age >= rows[rows.length - 1].age) return rows[rows.length - 1];

  for (let i = 0; i < rows.length - 1; i += 1) {
    const lo = rows[i];
    const hi = rows[i + 1];
    if (age >= lo.age && age <= hi.age) {
      const t = (age - lo.age) / (hi.age - lo.age);
      const blend = (key) => lo[key] * (1 - t) + hi[key] * t;
      const keys = [
        'a0','a1','a2','a3','a4','a5','a6',
        'p0','p1','p2','p3','p4','p5',
        'q0','q1','l0','l1','m0','m1','s0','s1',
      ];
      const out = { age };
      for (const k of keys) out[k] = blend(k);
      return out;
    }
  }
  return rows[rows.length - 1];
}

/**
 * Compute L, M, S for a variable + demographics.
 *
 * Uses the rspiro formulation:
 *   M = exp( a0 + a1*ln(height_cm) + a2*ln(age) + a3*E2 + a4*E3 + a5*E4 + a6*E5 + m0*m_spline + m1*m_spline2 )
 *   S = exp( p0 + p1*ln(age) + p2*E2 + p3*E3 + p4*E4 + p5*E5 + s0*s_spline + s1*s_spline2 )
 *   L = q0 + q1*ln(age) + l0*l_spline + l1*l_spline2
 *
 * rspiro packs the spline values into l0/l1, m0/m1, s0/s1 (already evaluated
 * at the agebound), so we treat them as additive constants after interpolation.
 */
function gli2012Lookup({ age, height, sex, ethnicity, variable }) {
  const table = COEFFICIENTS[variable];
  if (!table) return null;

  const rows = sex === 1 ? table.male : table.female;
  if (!rows || rows.length === 0) return null;

  const r = interpolateRow(rows, age);
  if (!r) return null;

  const eIdx = ETHNICITY_INDEX[ethnicity] ?? 0;
  const E = [0, 0, 0, 0, 0]; // E2..E5 (Caucasian = reference)
  if (eIdx >= 1) E[eIdx] = 1;

  const lnH = Math.log(height);
  const lnA = Math.log(age);

  const mLin =
    r.a0 + r.a1 * lnH + r.a2 * lnA +
    r.a3 * E[1] + r.a4 * E[2] + r.a5 * E[3] + r.a6 * E[4] +
    r.m0 + r.m1;

  const sLin =
    r.p0 + r.p1 * lnA +
    r.p2 * E[1] + r.p3 * E[2] + r.p4 * E[3] + r.p5 * E[4] +
    r.s0 + r.s1;

  const lLin = r.q0 + r.q1 * lnA + r.l0 + r.l1;

  const M = Math.exp(mLin);
  const S = Math.exp(sLin);
  const L = lLin;

  if (!Number.isFinite(M) || M <= 0) return null;
  if (!Number.isFinite(S) || S <= 0) return null;
  if (!Number.isFinite(L) || L === 0) return null;

  return { M, S, L };
}

function calculateGli2012(measured, demo, variable) {
  if (!Number.isFinite(measured) || measured <= 0) {
    return { predicted: null, lln: null, zScore: null, percentPredicted: null };
  }

  const gli = gli2012Lookup({
    age: demo.age,
    height: demo.height,
    sex: demo.sex,
    ethnicity: demo.ethnicity,
    variable,
  });

  if (!gli) {
    return { predicted: null, lln: null, zScore: null, percentPredicted: null };
  }

  const { M, S, L } = gli;

  const zScore = (Math.pow(measured / M, L) - 1) / (L * S);
  const lln = M * Math.pow(1 + L * S * -1.645, 1 / L);
  const predicted = M;
  const percentPredicted = (measured / M) * 100;

  return {
    predicted: round2(predicted),
    lln: round2(lln),
    zScore: round2(zScore),
    percentPredicted: round2(percentPredicted),
  };
}

module.exports = { calculateGli2012, gli2012Lookup };