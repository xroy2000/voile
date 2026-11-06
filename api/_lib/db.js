// Accès base de données : Neon (production) ou PGlite en mémoire (tests locaux, PGLITE=1).
let backend = null;
let schemaReady = null;

async function open() {
  if (backend) return backend;
  if (process.env.PGLITE === '1') {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    backend = async (text, params = []) => (await pg.query(text, params)).rows;
  } else {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL manquant : la base Neon n’est pas reliée au projet');
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    backend = async (text, params = []) => sql.query(text, params);
  }
  return backend;
}

export async function query(text, params = []) {
  const run = await open();
  return run(text, params);
}

const SCHEMA = [
  `create table if not exists users (
     id bigserial primary key,
     pseudo text not null,
     pseudo_lc text not null unique,
     pass_hash text not null,
     created_at timestamptz not null default now(),
     last_login timestamptz
   )`,
  `create table if not exists invites (
     id bigserial primary key,
     token_hash text not null unique,
     label text,
     user_id bigint references users(id) on delete cascade,
     expires_at timestamptz not null,
     used_at timestamptz,
     used_by bigint references users(id) on delete set null,
     revoked boolean not null default false,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists login_attempts (
     id bigserial primary key,
     key text not null,
     at timestamptz not null default now()
   )`,
  `create index if not exists login_attempts_key_at on login_attempts (key, at)`,
];

/** Crée les tables au premier appel (idempotent). */
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => { for (const s of SCHEMA) await query(s); })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
