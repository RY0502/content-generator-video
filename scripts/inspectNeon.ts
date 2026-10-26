import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_runs'");
      console.log("Columns:", res.rows.map(r => r.column_name));
      const count = await client.query("SELECT COUNT(*) FROM agent_runs");
      console.log("Total runs:", count.rows[0].count);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error inspecting Neon:", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
