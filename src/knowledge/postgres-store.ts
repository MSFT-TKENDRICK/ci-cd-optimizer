import postgres, { type Sql } from "postgres";
import { validateScope } from "./identity.js";
import { validateQuery, validateSnapshot } from "./store.js";
import type { KnowledgeQuery, KnowledgeScope, KnowledgeSnapshot, KnowledgeStore, KnowledgeSummary, ProjectEvidence, ProjectRelationship, TechnologyEvidence } from "./types.js";

interface Header {
  id: string;
  host: string;
  repository_id: string;
  owner: string;
  repo: string;
  revision: string;
  collected_at: Date;
  coverage: KnowledgeSnapshot["coverage"];
}

const summary = (row: Header): KnowledgeSummary => ({
  id: row.id, repository: { host: row.host, repositoryId: row.repository_id, owner: row.owner, repo: row.repo },
  revision: row.revision, collectedAt: row.collected_at.toISOString(), coverage: row.coverage,
});

/** Normalized, append-only revision evidence. Every read requires a host/repository scope. */
export class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly sql: Sql;
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10 });
  }
  async initialize(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout = '10s'`;
      await sql`SET LOCAL statement_timeout = '60s'`;
      await sql`SELECT pg_advisory_xact_lock(hashtext('ci-cd-optimizer:knowledge-schema-v1'))`;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_snapshots (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version = 1),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
          revision TEXT NOT NULL, collected_at TIMESTAMPTZ NOT NULL, coverage JSONB NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_projects (
          snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id), id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('repository', 'npm-package', 'configuration-root')), path TEXT NOT NULL, name TEXT,
          PRIMARY KEY (snapshot_id, id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_technologies (
          snapshot_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
          technology TEXT NOT NULL, basis TEXT NOT NULL, source JSONB NOT NULL, spec JSONB,
          PRIMARY KEY (snapshot_id, id),
          FOREIGN KEY (snapshot_id, project_id) REFERENCES knowledge_projects(snapshot_id, id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_relationships (
          snapshot_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('contains', 'workspace-member', 'declares-dependency')),
          source_project_id TEXT NOT NULL, target_project_id TEXT, target_name TEXT, dependency_scope TEXT, resolution TEXT,
          source JSONB NOT NULL, spec JSONB, PRIMARY KEY (snapshot_id, id),
          FOREIGN KEY (snapshot_id, source_project_id) REFERENCES knowledge_projects(snapshot_id, id),
          FOREIGN KEY (snapshot_id, target_project_id) REFERENCES knowledge_projects(snapshot_id, id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_snapshot_scope ON knowledge_snapshots (host, repository_id, revision, collected_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_technology_lookup ON knowledge_technologies (snapshot_id, technology, project_id)`;
    });
  }
  async save(input: KnowledgeSnapshot): Promise<void> {
    const snapshot = structuredClone(input);
    validateSnapshot(snapshot);
    await this.sql.begin(async (sql) => {
      const json = (value: unknown) => sql.json(JSON.parse(JSON.stringify(value)) as postgres.JSONValue);
      const inserted = await sql`
        INSERT INTO knowledge_snapshots (id, version, host, repository_id, owner, repo, revision, collected_at, coverage)
        VALUES (${snapshot.id}, ${snapshot.version}, ${snapshot.repository.host}, ${snapshot.repository.repositoryId},
          ${snapshot.repository.owner}, ${snapshot.repository.repo}, ${snapshot.revision}, ${snapshot.collectedAt}, ${json(snapshot.coverage)})
        ON CONFLICT (id) DO NOTHING RETURNING id
      `;
      if (inserted.length === 0) return;
      const projects = snapshot.projects.map((project) => ({ snapshot_id: snapshot.id, id: project.id, kind: project.kind, path: project.path, name: project.name ?? null }));
      for (let i = 0; i < projects.length; i += 500) {
        await sql`INSERT INTO knowledge_projects ${sql(projects.slice(i, i + 500), "snapshot_id", "id", "kind", "path", "name")}`;
      }
      const technologies = snapshot.technologies.map((fact) => ({
        snapshot_id: snapshot.id, id: fact.id, project_id: fact.projectId, technology: fact.technology, basis: fact.basis,
        source: json(fact.source), spec: fact.spec ? json(fact.spec) : null,
      }));
      for (let i = 0; i < technologies.length; i += 500) {
        await sql`INSERT INTO knowledge_technologies ${sql(technologies.slice(i, i + 500), "snapshot_id", "id", "project_id", "technology", "basis", "source", "spec")}`;
      }
      const relationships = snapshot.relationships.map((edge) => ({
        snapshot_id: snapshot.id, id: edge.id, kind: edge.kind, source_project_id: edge.from, target_project_id: edge.to ?? null,
        target_name: edge.targetName ?? null, dependency_scope: edge.scope ?? null, resolution: edge.resolution ?? null,
        source: json(edge.source), spec: edge.spec ? json(edge.spec) : null,
      }));
      for (let i = 0; i < relationships.length; i += 500) {
        await sql`INSERT INTO knowledge_relationships ${sql(relationships.slice(i, i + 500), "snapshot_id", "id", "kind", "source_project_id", "target_project_id", "target_name", "dependency_scope", "resolution", "source", "spec")}`;
      }
    });
  }
  async load(scope: KnowledgeScope, id: string): Promise<KnowledgeSnapshot | undefined> {
    validateScope(scope);
    const [header] = await this.sql<Header[]>`
      SELECT id, host, repository_id, owner, repo, revision, collected_at, coverage FROM knowledge_snapshots
      WHERE id = ${id} AND host = ${scope.host} AND repository_id = ${scope.repositoryId}
    `;
    if (!header) return undefined;
    const [projects, technologies, relationships] = await Promise.all([
      this.sql<(Omit<ProjectEvidence, "name"> & { name: string | null })[]>`
        SELECT id, kind, path, name FROM knowledge_projects WHERE snapshot_id = ${id} ORDER BY id
      `,
      this.sql<(Omit<TechnologyEvidence, "spec"> & { spec: TechnologyEvidence["spec"] | null })[]>`
        SELECT id, project_id AS "projectId", technology, basis, source, spec FROM knowledge_technologies WHERE snapshot_id = ${id} ORDER BY id
      `,
      this.sql<(Omit<ProjectRelationship, "to" | "targetName" | "scope" | "resolution" | "spec"> & {
        to: string | null; targetName: string | null; scope: ProjectRelationship["scope"] | null;
        resolution: ProjectRelationship["resolution"] | null; spec: ProjectRelationship["spec"] | null;
      })[]>`
        SELECT id, kind, source_project_id AS "from", target_project_id AS "to", target_name AS "targetName",
          dependency_scope AS scope, resolution, source, spec FROM knowledge_relationships WHERE snapshot_id = ${id} ORDER BY id
      `,
    ]);
    const snapshot: KnowledgeSnapshot = {
      version: 1, ...summary(header),
      projects: projects.map(({ name, ...project }) => ({ ...project, ...(name !== null ? { name } : {}) })),
      technologies: technologies.map(({ spec, ...fact }) => ({ ...fact, ...(spec ? { spec } : {}) })),
      relationships: relationships.map(({ to, targetName, scope, resolution, spec, ...edge }) => ({
        ...edge, ...(to !== null ? { to } : {}), ...(targetName !== null ? { targetName } : {}),
        ...(scope ? { scope } : {}), ...(resolution ? { resolution } : {}), ...(spec ? { spec } : {}),
      })),
    };
    validateSnapshot(snapshot);
    return snapshot;
  }
  async list(query: KnowledgeQuery): Promise<KnowledgeSummary[]> {
    validateQuery(query);
    const rows = await this.sql<Header[]>`
      SELECT id, host, repository_id, owner, repo, revision, collected_at, coverage FROM knowledge_snapshots s
      WHERE host = ${query.host} AND repository_id = ${query.repositoryId}
        ${query.revision === undefined ? this.sql`` : this.sql`AND revision = ${query.revision}`}
        ${query.projectId === undefined ? this.sql`` : this.sql`AND EXISTS (SELECT 1 FROM knowledge_projects p WHERE p.snapshot_id = s.id AND p.id = ${query.projectId})`}
        ${query.technology === undefined ? this.sql`` : this.sql`AND EXISTS (
          SELECT 1 FROM knowledge_technologies t WHERE t.snapshot_id = s.id AND t.technology = ${query.technology}
          ${query.projectId === undefined ? this.sql`` : this.sql`AND t.project_id = ${query.projectId}`}
        )`}
      ORDER BY collected_at DESC, id DESC LIMIT ${query.limit}
    `;
    return rows.map(summary);
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}
