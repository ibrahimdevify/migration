#!/usr/bin/env node
// migrate.js — main entry point
//
// Usage:
//   node src/migrate.js                → runs all steps in order
//   node src/migrate.js --only=users    → runs a single named step
//   node src/migrate.js --dry-run       → connects and validates, writes nothing
//
// SECURITY REMINDER: this script and everything it calls must never
// console.log row contents (names, emails, phone numbers, diagnoses, etc).
// Only counts and IDs. See logger.js.

require('dotenv').config();
const logger = require('./logger');
const { closeAll } = require('./db');
const { ensureIdMapTable } = require('./idMap');
const { ensureCheckpointTable } = require('./checkpoint');

const lookups = require('./steps/01_lookups');
const accounts = require('./steps/02_accounts');
const patientGroups = require('./steps/03_patient_groups');
const users = require('./steps/04_users');
const portalUsers = require('./steps/05_portal_users');
const clinicalData = require('./steps/06_clinical_data');
const heartRate = require('./steps/07_heart_rate');
const predictedValues = require('./steps/08_predicted_values');
const patientDoctorDetails = require('./steps/09_patient_doctor_details');
const spirometryTrends = require('./steps/10_spirometry_trends');
const syncOldDbUsers = require('./steps/11_sync_old_db_users');
const syncOldDbClinical = require('./steps/12_sync_old_db_clinical');
const syncOldDbPatientDoctorDetails = require('./steps/13_sync_old_db_patient_doctor_details');

const STEPS = [
  { name: 'lookups', run: lookups.run },
  { name: 'accounts', run: accounts.run },
  { name: 'patient_groups', run: patientGroups.run },
  { name: 'users', run: users.run },
  { name: 'portal_users', run: portalUsers.run },
  { name: 'clinical_data', run: clinicalData.run },
  { name: 'heart_rate', run: heartRate.run },
  { name: 'predicted_values', run: predictedValues.run },
  { name: 'patient_doctor_details', run: patientDoctorDetails.run },
  { name: 'spirometry_trends', run: spirometryTrends.run },
  // Delta sync from the OLD live database — run these LAST, after
  // everything above has completed, since they depend on the new
  // database already having the full historical migration in place.
  { name: 'sync_old_db_users', run: syncOldDbUsers.run },
  { name: 'sync_old_db_clinical', run: syncOldDbClinical.run },
  { name: 'sync_old_db_patient_doctor_details', run: syncOldDbPatientDoctorDetails.run },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  return { dryRun, only };
}

async function main() {
  const { dryRun, only } = parseArgs();

  if (dryRun) {
    logger.info('DRY RUN MODE — no data will be written. (Connection + setup checks only.)');
  }

  await ensureIdMapTable();
  await ensureCheckpointTable();

  let lookupResults = null;

  for (const step of STEPS) {
    if (only && step.name !== only) continue;

    if (dryRun) {
      logger.info(`[dry-run] Would run step: ${step.name}`);
      continue;
    }

    try {
      if (step.name === 'lookups') {
        lookupResults = await step.run();
      } else if (step.name === 'users' || step.name === 'portal_users') {
        if (!lookupResults) {
          logger.info('Loading existing lookup ID maps from database (lookups step not run this session)...');
          lookupResults = await lookups.loadExistingLookupMaps();
        }
        await step.run(lookupResults);
      } else {
        await step.run();
      }
    } catch (err) {
      logger.error(`Step "${step.name}" failed — stopping migration.`, err);
      await closeAll();
      process.exit(1);
    }
  }

  logger.info('Migration run finished.');
  await closeAll();
}

main().catch(async (err) => {
  logger.error('Unhandled error in migration script', err);
  await closeAll();
  process.exit(1);
});
