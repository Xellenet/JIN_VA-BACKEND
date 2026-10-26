import type { DataSource } from 'typeorm';

/**
 * Removes what an e2e suite created, so the shared dev database keeps only its
 * realistic seed data. Users go first: profiles, bookings, jobs, payments,
 * disputes, reviews, messages, notifications and tokens all cascade from
 * `users`. Services go last, because `jobs.service_id` is RESTRICT.
 */
export async function removeTestData(
  dataSource: DataSource,
  {
    userIds = [],
    serviceIds = [],
  }: { userIds?: number[]; serviceIds?: number[] },
): Promise<void> {
  if (userIds.length) {
    await dataSource.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
  if (serviceIds.length) {
    await dataSource.query('DELETE FROM services WHERE id = ANY($1)', [
      serviceIds,
    ]);
  }
}

/** The user ids a suite created, found by its own email prefix on the test domain. */
export async function testUserIds(
  dataSource: DataSource,
  prefix: string,
): Promise<number[]> {
  const rows: Array<{ id: number }> = await dataSource.query(
    "SELECT id FROM users WHERE email LIKE $1 || '%@test.jinva.local'",
    [prefix],
  );
  return rows.map((r) => r.id);
}
