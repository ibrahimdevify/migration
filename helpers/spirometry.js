// src/helpers/spirometry.js
'use strict';

const { calculateGli2012 } = require('./gli2012');

const RAW_SPIROMETRY_SCALE_FACTOR = 100;

// ─────────────────────────────────────────────────────────────
// Scale / normalization
// ─────────────────────────────────────────────────────────────

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isNaN(number)) return null;
  return number;
};

const normalizeSpirometryValue = (rawValue) => {
  const value = toNumberOrNull(rawValue);
  if (value === null) return null;
  if (Math.abs(value) >= RAW_SPIROMETRY_SCALE_FACTOR / 5) {
    return Number((value / RAW_SPIROMETRY_SCALE_FACTOR).toFixed(2));
  }
  return Number(value.toFixed(2));
};

const mapSpirometryInput = (val = {}) => {
  const firstDefined = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };
  return {
    fvc: firstDefined(val.fvcL, val.fvc),
    fev1: firstDefined(val.fev1L, val.fev1),
    pefr: firstDefined(val.pefLs, val.pefr),
    fef2575: firstDefined(val.fef2575Ls, val.fef2575),
    fev6: firstDefined(val.fev6L, val.fev6),
    fev1_perc: firstDefined(val.fev1Perc, val.fev1_perc),
    btps: firstDefined(val.btps),
    temp_celsius: firstDefined(val.tempCelsius, val.temp_celsius),
    quality_message: firstDefined(val.qualityMessage, val.quality_message),
  };
};

// ─────────────────────────────────────────────────────────────
// Demographics mapping
// ─────────────────────────────────────────────────────────────

const toGliSex = (sexAtBirth) => {
  const s = String(sexAtBirth || '').trim().toLowerCase();
  if (s.startsWith('m')) return 1;
  if (s.startsWith('f')) return 2;
  return 1; // default male
};



const normalizeDemo = (demo = {}) => ({
  age: Number.isFinite(demo.age) && demo.age > 0 ? Number(demo.age) : 40,
  height: Number.isFinite(demo.height) && demo.height > 0 ? Number(demo.height) : 170,
  sex: demo.sex === 1 || demo.sex === 2 ? demo.sex : toGliSex(demo.sexAtBirth),
  ethnicity: demo.ethnicity >= 1 && demo.ethnicity <= 5 ? demo.ethnicity : toGliEthnicity(demo.ethnicity),
});

const toGliEthnicity = (lookupTable) => {
  const v = String(lookupTable || '').trim();
  if (v === 'Caucasian')       return 1;
  if (v === 'AfricanAmerican') return 2;
  if (v === 'NEAsian')         return 3;
  if (v === 'SEAsian')         return 4;
  return 5; // other
};

const toGliDemographics = (profile) => {
  if (!profile) return { age: 40, height: 170, sex: 1, ethnicity: 5 };

  const attrs = profile.attributes || {};
  const details = profile.patient_details || {};

  // Django uses lookup_table exclusively. Fall back to ethnic_group only
  // if lookup_table is null (which won't happen in Django's flow).
  const ethnicitySource = profile.lookup_table || attrs.lookup_table;

  return {
    age: Number.isFinite(profile.age) && profile.age > 0 ? profile.age : 40,
    height: attrs.height ?? details.height ?? 170,
    sex: toGliSex(attrs.gender || profile.sexAtBirth),
    ethnicity: toGliEthnicity(ethnicitySource),
  };
};

// ─────────────────────────────────────────────────────────────
// Predicted values (synchronous)
// ─────────────────────────────────────────────────────────────

const calculatePredictedValues = (rawValue, demo = {}, variable = 'FEV1') => {
  const value = normalizeSpirometryValue(rawValue);
  if (value === null || value <= 0) {
    return { predicted: null, lln: null, zScore: null, percentPredicted: null };
  }
  const normalized = normalizeDemo(demo);
  return calculateGli2012(value, normalized, variable);
};

const calculateFev1FvcRatio = (fev1, fvc) => {
  const normalizedFev1 = normalizeSpirometryValue(fev1);
  const normalizedFvc = normalizeSpirometryValue(fvc);
  if (normalizedFev1 === null || normalizedFvc === null || normalizedFvc === 0) return null;
  return Number((normalizedFev1 / normalizedFvc).toFixed(2));
};

const calculateFev1FvcPredictedValues = (fev1FvcRatioOrPercent, demo = {}) => {
  if (fev1FvcRatioOrPercent === null || fev1FvcRatioOrPercent === undefined) {
    return { predicted: null, lln: null, zScore: null, percentPredicted: null };
  }
  const observedRatio =
    fev1FvcRatioOrPercent > 1.5 ? fev1FvcRatioOrPercent / 100 : fev1FvcRatioOrPercent;
  const normalized = normalizeDemo(demo);
  return calculateGli2012(observedRatio, normalized, 'FEV1FVC');
};

// ─────────────────────────────────────────────────────────────
// Record normalization + best-pick
// ─────────────────────────────────────────────────────────────

const normalizeSpirometry = (sp = {}) => {
  const fev1 = normalizeSpirometryValue(sp.fev1);
  const fvc = normalizeSpirometryValue(sp.fvc);
  const pefr = normalizeSpirometryValue(sp.pefr);
  const fef2575 = normalizeSpirometryValue(sp.fef2575);
  const fev6 = normalizeSpirometryValue(sp.fev6);
  const fev1FvcRatio = calculateFev1FvcRatio(fev1, fvc);
  return {
    ...sp,
    fev1,
    fvc,
    pefr,
    fef2575,
    fev6,
    fev1_perc: toNumberOrNull(sp.fev1_perc),
    fev1_fvc_ratio: fev1FvcRatio,
  };
};

const buildPredictedSpirometry = (sp = {}, demo = {}) => {
  const normalized = normalizeSpirometry(sp);
  return {
    fev1: calculatePredictedValues(normalized.fev1, demo, 'FEV1'),
    fvc: calculatePredictedValues(normalized.fvc, demo, 'FVC'),
    fev1_fvc: calculateFev1FvcPredictedValues(normalized.fev1_fvc_ratio, demo),
    fef2575: calculatePredictedValues(normalized.fef2575, demo, 'FEF2575'),
    fev6: calculatePredictedValues(normalized.fev6, demo, 'FEV1'),
    pefr: calculatePredictedValues(normalized.pefr, demo, 'FEV1'),
  };
};

const pickBestSpirometry = (spirometries = []) => {
  const normalized = spirometries
    .map(normalizeSpirometry)
    .filter((sp) => sp.fev1 !== null || sp.fvc !== null || sp.pefr !== null || sp.fef2575 !== null || sp.fev6 !== null);

  if (!normalized.length) return null;

  return normalized.reduce((best, current) => {
    if (!best) return current;
    const bestFev1 = best.fev1 ?? -Infinity;
    const currentFev1 = current.fev1 ?? -Infinity;
    if (currentFev1 > bestFev1) return current;
    if (currentFev1 < bestFev1) return best;
    const bestFvc = best.fvc ?? -Infinity;
    const currentFvc = current.fvc ?? -Infinity;
    return currentFvc > bestFvc ? current : best;
  }, null);
};

module.exports = {
  RAW_SPIROMETRY_SCALE_FACTOR,
  normalizeSpirometryValue,
  normalizeSpirometry,
  mapSpirometryInput,
  calculatePredictedValues,
  calculateFev1FvcRatio,
  calculateFev1FvcPredictedValues,
  buildPredictedSpirometry,
  pickBestSpirometry,
  toGliDemographics,
  toGliSex,
  toGliEthnicity,
};