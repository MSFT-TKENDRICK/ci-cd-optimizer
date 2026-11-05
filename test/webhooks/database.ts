import { randomUUID } from "node:crypto";
import postgres from "postgres";

export async function isolatedDatabase(databaseUrl: string) {
  const admin = postgres(databaseUrl, { max: 1 });
  const schema = `webhooks_${randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const sql = postgres(url.toString(), { max: 1 });
  const [row] = await sql<{ name: string }[]>`SELECT current_schema() AS name`;
  if (row?.name !== schema) {
    await sql.end();
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
    throw new Error("Test database search_path isolation failed");
  }
  return {
    url: url.toString(),
    sql,
    close: async () => {
      await sql.end();
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
      await admin.end();
    },
  };
}
