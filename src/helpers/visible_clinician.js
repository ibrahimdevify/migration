const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const getVisibleClinicianIds = async (user) => {
  // System admin: sees every clinician (ut_id_fk = 3) in the system,
  // plus any clinician-admins (ut_id_fk = 6) that patients are
  // assigned to directly.
  if (user.ut_id_fk === 2) {
    const allClinicians = await prisma.dc_users.findMany({
      where: {
        ut_id_fk: { in: [3, 6] }, // 👈 FIXED: clinicians + clinician admins
        us_id_fk: 1,
      },
      select: { user_id: true },
    });

    return allClinicians.map((c) => c.user_id);
  }

  // Plain clinician: only their own patients.
  if (user.ut_id_fk === 3) {
    return [user.user_id];
  }

  // Clinician admin: themselves + every clinician they manage.
  if (user.ut_id_fk === 6) {
    const managed = await prisma.dc_clinician_assignments.findMany({
      where: { clinician_admin_id: user.user_id },
      select: { clinician_id: true },
    });

    const managedIds = managed.map((m) => m.clinician_id);
    return [user.user_id, ...managedIds];
  }

  return [];
};

module.exports = { getVisibleClinicianIds };