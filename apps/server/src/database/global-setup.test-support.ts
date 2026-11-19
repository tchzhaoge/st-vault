import { startTestPostgres } from './postgres.test-support.js';
export default async function setup() {
  const database = await startTestPostgres();
  return () => database.close();
}
