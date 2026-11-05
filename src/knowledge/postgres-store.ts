import postgres, { type Sql } from "postgres";
import { validateScope } from "./identity.js";
import {
  equivalentMitigationDefinitions,
  validateMitigationApplication, validateMitigationApplicationEvent, validateMitigationDefinition,
  validateMitigationEvaluation, verifyMitigationEvaluation,
} from "./mitigation.js";
import { validateQuery, validateSnapshot } from "./store.js";
import { MAINTENANCE_LIMIT, planMaintenance, validateMaintenanceRequest, type MaintenanceTargets } from "./maintenance.js";
import { validateExecutionObservation } from "./execution.js";
import { validateRunObservation, validateRunObservationQuery, validateRunSource } from "./run-observation.js";
import { MAX_RUN_OBSERVATIONS, MAX_RUN_OBSERVATION_BYTES, runWindowFromRows, validateRunWindowQuery } from "./run-window.js";
import type {
  KnowledgeQuery, KnowledgeScope, KnowledgeSnapshot, KnowledgeStore, KnowledgeSummary, MitigationApplication,
  MitigationApplicationEvent, MitigationDefinition, MitigationEvaluation, ProjectEvidence, ProjectRelationship,
  TechnologyEvidence, RunObservation, RunObservationQuery, RunObservationSummary, RunEvidenceWindow, RunEvidenceWindowQuery,
  KnowledgeMaintenanceRequest, KnowledgeMaintenancePlan, ExecutionObservation,
} from "./types.js";

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
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_snapshot_reference ON knowledge_snapshots (host, repository_id, revision, id)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_snapshot_project_reference ON knowledge_snapshots (id, host, repository_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_run_observations (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version = 1),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
          revision TEXT NOT NULL, run_id BIGINT NOT NULL CHECK (run_id > 0),
          run_attempt INTEGER NOT NULL CHECK (run_attempt > 0), workflow_id BIGINT NOT NULL CHECK (workflow_id > 0),
          observed_at TIMESTAMPTZ NOT NULL, source_snapshot_id TEXT, observation JSONB NOT NULL,
          FOREIGN KEY (host, repository_id, revision, source_snapshot_id)
            REFERENCES knowledge_snapshots (host, repository_id, revision, id)
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_run_scope_reference ON knowledge_run_observations (id, host, repository_id)`;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_run_scope ON knowledge_run_observations (host, repository_id, observed_at DESC, id DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_run_attempt ON knowledge_run_observations (host, repository_id, run_id, run_attempt)`;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_run_source ON knowledge_run_observations (source_snapshot_id)`;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_run_workflow ON knowledge_run_observations (host, repository_id, workflow_id, (observation->'run'->>'branch'), run_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_definitions (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CONSTRAINT mitigation_definitions_version_supported CHECK (version IN (1, 2)),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
          definition_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
          content_digest TEXT NOT NULL, definition JSONB NOT NULL,
          UNIQUE (host, repository_id, definition_key, revision),
          UNIQUE (id, host, repository_id)
        )
      `;
      await sql`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mitigation_definitions'::regclass
            AND conname = 'mitigation_definitions_version_check') THEN
            ALTER TABLE mitigation_definitions DROP CONSTRAINT mitigation_definitions_version_check;
            ALTER TABLE mitigation_definitions ADD CONSTRAINT mitigation_definitions_version_supported CHECK (version IN (1, 2));
          END IF;
        END $$
      `;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_definition_scope ON mitigation_definitions (host, repository_id, definition_key, revision DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_applications (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version = 1),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, definition_id TEXT NOT NULL,
          topology_snapshot_id TEXT NOT NULL, change JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
          application JSONB NOT NULL, UNIQUE (id, host, repository_id),
          UNIQUE (id, topology_snapshot_id, host, repository_id),
          FOREIGN KEY (definition_id) REFERENCES mitigation_definitions (id),
          FOREIGN KEY (topology_snapshot_id, host, repository_id)
            REFERENCES knowledge_snapshots (id, host, repository_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_application_scope ON mitigation_applications (host, repository_id, created_at DESC, id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_application_projects (
          application_id TEXT NOT NULL, host TEXT NOT NULL, repository_id TEXT NOT NULL,
          topology_snapshot_id TEXT NOT NULL, project_id TEXT NOT NULL,
          PRIMARY KEY (application_id, project_id),
          FOREIGN KEY (application_id, topology_snapshot_id, host, repository_id)
            REFERENCES mitigation_applications (id, topology_snapshot_id, host, repository_id),
          FOREIGN KEY (topology_snapshot_id, project_id)
            REFERENCES knowledge_projects (snapshot_id, id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_application_events (
          id TEXT PRIMARY KEY, host TEXT NOT NULL, repository_id TEXT NOT NULL, application_id TEXT NOT NULL,
          observed_at TIMESTAMPTZ NOT NULL, run_observation_id TEXT, event JSONB NOT NULL,
          UNIQUE (id, host, repository_id),
          FOREIGN KEY (application_id, host, repository_id)
            REFERENCES mitigation_applications (id, host, repository_id),
          FOREIGN KEY (run_observation_id, host, repository_id)
            REFERENCES knowledge_run_observations (id, host, repository_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_event_application ON mitigation_application_events (host, repository_id, application_id, observed_at, id)`;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_event_observation ON mitigation_application_events (run_observation_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_evaluations (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version = 1),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, application_id TEXT NOT NULL,
          evaluated_at TIMESTAMPTZ NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('observed-faster', 'observed-slower', 'no-detected-difference', 'inconclusive', 'unknown')),
          evaluation JSONB NOT NULL,
          UNIQUE (id, host, repository_id),
          FOREIGN KEY (application_id, host, repository_id)
            REFERENCES mitigation_applications (id, host, repository_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_evaluation_application ON mitigation_evaluations (host, repository_id, application_id, evaluated_at DESC, id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS mitigation_evaluation_samples (
          evaluation_id TEXT NOT NULL, host TEXT NOT NULL, repository_id TEXT NOT NULL,
          side TEXT NOT NULL CHECK (side IN ('control', 'treatment')), run_observation_id TEXT NOT NULL,
          PRIMARY KEY (evaluation_id, side, run_observation_id),
          FOREIGN KEY (evaluation_id, host, repository_id)
            REFERENCES mitigation_evaluations (id, host, repository_id),
          FOREIGN KEY (run_observation_id, host, repository_id)
            REFERENCES knowledge_run_observations (id, host, repository_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS mitigation_sample_observation ON mitigation_evaluation_samples (run_observation_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS knowledge_execution_observations (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version = 1),
          host TEXT NOT NULL, repository_id TEXT NOT NULL, run_observation_id TEXT NOT NULL,
          job_id BIGINT NOT NULL CHECK (job_id > 0), recorded_at TIMESTAMPTZ NOT NULL, execution JSONB NOT NULL,
          FOREIGN KEY (run_observation_id, host, repository_id) REFERENCES knowledge_run_observations (id, host, repository_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS knowledge_execution_run ON knowledge_execution_observations (run_observation_id, host, repository_id, recorded_at DESC, id)`;
    });
  }
  async save(input: KnowledgeSnapshot): Promise<void> {
    const snapshot = structuredClone(input);
    validateSnapshot(snapshot);
    await this.sql.begin((sql) => this.insertSnapshot(sql, snapshot));
  }
  private async insertSnapshot(sql: postgres.TransactionSql, snapshot: KnowledgeSnapshot): Promise<void> {
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
  async saveRunObservation(input: RunObservation, sourceInput?: KnowledgeSnapshot): Promise<void> {
    const observation = structuredClone(input);
    const source = sourceInput ? structuredClone(sourceInput) : undefined;
    validateRunObservation(observation);
    if (source) {
      validateSnapshot(source);
      validateRunSource(observation, source);
    }
    await this.sql.begin(async (sql) => {
      if (source) await this.insertSnapshot(sql, source);
      await sql`
        INSERT INTO knowledge_run_observations (
          id, version, host, repository_id, owner, repo, revision, run_id, run_attempt, workflow_id, observed_at, source_snapshot_id, observation
        ) VALUES (
          ${observation.id}, ${observation.version}, ${observation.repository.host}, ${observation.repository.repositoryId},
          ${observation.repository.owner}, ${observation.repository.repo}, ${observation.run.headSha}, ${observation.run.runId},
          ${observation.run.runAttempt}, ${observation.run.workflowId}, ${observation.observedAt},
          ${observation.source.status === "linked" ? observation.source.snapshotId : null},
          ${sql.json(JSON.parse(JSON.stringify(observation)) as postgres.JSONValue)}
        ) ON CONFLICT (id) DO NOTHING
      `;
    });
  }
  async loadRunObservation(scope: KnowledgeScope, id: string): Promise<RunObservation | undefined> {
    validateScope(scope);
    const [row] = await this.sql<{ observation: RunObservation }[]>`
      SELECT observation FROM knowledge_run_observations WHERE id = ${id} AND host = ${scope.host} AND repository_id = ${scope.repositoryId}
    `;
    if (!row) return undefined;
    validateRunObservation(row.observation);
    if (row.observation.id !== id || row.observation.repository.host !== scope.host || row.observation.repository.repositoryId !== scope.repositoryId) {
      throw new Error("Stored run observation does not match its indexed identity");
    }
    return row.observation;
  }
  async listRunObservations(query: RunObservationQuery): Promise<RunObservationSummary[]> {
    validateRunObservationQuery(query);
    const rows = await this.sql<{
      id: string; host: string; repository_id: string; owner: string; repo: string; revision: string;
      run_id: string; run_attempt: number; workflow_id: string; observed_at: Date; source_snapshot_id: string | null;
    }[]>`
      SELECT id, host, repository_id, owner, repo, revision, run_id, run_attempt, workflow_id, observed_at, source_snapshot_id
      FROM knowledge_run_observations
      WHERE host = ${query.host} AND repository_id = ${query.repositoryId}
        ${query.runId === undefined ? this.sql`` : this.sql`AND run_id = ${query.runId}`}
        ${query.runAttempt === undefined ? this.sql`` : this.sql`AND run_attempt = ${query.runAttempt}`}
        ${query.revision === undefined ? this.sql`` : this.sql`AND revision = ${query.revision}`}
      ORDER BY observed_at DESC, id DESC LIMIT ${query.limit}
    `;
    return rows.map((row) => ({
      id: row.id, repository: { host: row.host, repositoryId: row.repository_id, owner: row.owner, repo: row.repo },
      observedAt: row.observed_at.toISOString(), revision: row.revision,
      runId: Number(row.run_id), runAttempt: row.run_attempt, workflowId: Number(row.workflow_id),
      source: row.source_snapshot_id ? { status: "linked", snapshotId: row.source_snapshot_id } : { status: "unavailable", reason: "revision-unavailable" },
    }));
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
  async readRunWindow(input: RunEvidenceWindowQuery): Promise<RunEvidenceWindow> {
    const query = structuredClone(input);
    validateRunWindowQuery(query);
    const rows = await this.sql.begin(async (sql) => {
      await sql`SET LOCAL statement_timeout = '10s'`;
      return sql<{ run_id: string; id: string; observation: RunObservation | null }[]>`
        WITH matching_runs AS (
          SELECT DISTINCT run_id FROM knowledge_run_observations
          WHERE host = ${query.host} AND repository_id = ${query.repositoryId}
          AND (run_id = ${query.referenceRunId} OR (
            workflow_id = ${query.workflowId} AND observation->'run'->>'branch' IS NOT DISTINCT FROM ${query.branch}
          ))
        ), candidates AS (
          SELECT k.run_id, MAX(k.observed_at) AS latest FROM knowledge_run_observations k
          JOIN matching_runs m ON m.run_id = k.run_id
          WHERE k.host = ${query.host} AND k.repository_id = ${query.repositoryId}
          GROUP BY k.run_id
          ORDER BY (k.run_id = ${query.referenceRunId}) DESC, latest DESC, k.run_id DESC
          LIMIT ${query.limit + 1}
        )
        SELECT c.run_id, o.id,
          CASE WHEN octet_length(o.observation::text) <= ${MAX_RUN_OBSERVATION_BYTES} THEN o.observation ELSE NULL END AS observation
        FROM candidates c
        CROSS JOIN LATERAL (
          SELECT id, observation, observed_at FROM knowledge_run_observations
          WHERE host = ${query.host} AND repository_id = ${query.repositoryId} AND run_id = c.run_id
          ORDER BY observed_at DESC, id DESC LIMIT ${MAX_RUN_OBSERVATIONS + 1}
        ) o
        ORDER BY (c.run_id = ${query.referenceRunId}) DESC, c.latest DESC, c.run_id DESC, o.observed_at DESC, o.id DESC
      `;
    });
    return runWindowFromRows(query, rows.map((row) => ({ ...row, runId: Number(row.run_id) })));
  }
  async saveMitigationDefinition(input: MitigationDefinition): Promise<MitigationDefinition> {
    const definition = structuredClone(input);
    validateMitigationDefinition(definition);
    return this.sql.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout = '10s'`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([
        "mitigation-definition", definition.source.host, definition.source.repositoryId, definition.key, definition.revision,
      ])}))`;
      const [existing] = await sql<{ id: string; definition: MitigationDefinition }[]>`
        SELECT id, definition FROM mitigation_definitions
        WHERE host = ${definition.source.host} AND repository_id = ${definition.source.repositoryId}
          AND definition_key = ${definition.key} AND revision = ${definition.revision}
      `;
      if (existing) {
        validateMitigationDefinition(existing.definition);
        if (existing.id !== existing.definition.id || !equivalentMitigationDefinitions(existing.definition, definition)) {
          throw new Error("Mitigation definition revision already has different immutable content");
        }
        return existing.definition;
      }
      await sql`
        INSERT INTO mitigation_definitions (id, version, host, repository_id, owner, repo, definition_key, revision, content_digest, definition)
        VALUES (${definition.id}, ${definition.version}, ${definition.source.host}, ${definition.source.repositoryId},
          ${definition.source.owner}, ${definition.source.repo}, ${definition.key}, ${definition.revision}, ${definition.contentDigest},
          ${sql.json(JSON.parse(JSON.stringify(definition)) as postgres.JSONValue)})
        ON CONFLICT (id) DO NOTHING
      `;
      return definition;
    });
  }

  async maintain(input: KnowledgeMaintenanceRequest): Promise<KnowledgeMaintenancePlan> {
    const request = structuredClone(input);
    validateMaintenanceRequest(request);
    return this.sql.begin(request.confirmation ? "isolation level read committed" : "isolation level repeatable read read only", async (sql) => {
      await sql`SET LOCAL lock_timeout = '10s'`;
      await sql`SET LOCAL statement_timeout = '60s'`;
      if (request.confirmation) {
        await sql`
          LOCK TABLE knowledge_snapshots, knowledge_projects, knowledge_technologies, knowledge_relationships,
            knowledge_run_observations, mitigation_definitions, mitigation_applications, mitigation_application_projects,
            mitigation_application_events, mitigation_evaluations, mitigation_evaluation_samples, knowledge_execution_observations
          IN SHARE ROW EXCLUSIVE MODE
        `;
      }
      const targets: MaintenanceTargets = { definitions: [], applications: [], events: [], evaluations: [], runs: [], snapshots: [], executions: [], crossRepositoryApplications: 0 };
      if (request.mode === "purge") {
        targets.definitions = (await sql<{ id: string }[]>`
          SELECT id FROM mitigation_definitions WHERE host = ${request.host} AND repository_id = ${request.repositoryId}
          ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
        const applications = await sql<{ id: string; host: string; repository_id: string }[]>`
          SELECT id, host, repository_id FROM mitigation_applications
          WHERE (host = ${request.host} AND repository_id = ${request.repositoryId})
            OR definition_id IN (SELECT id FROM mitigation_definitions WHERE host = ${request.host} AND repository_id = ${request.repositoryId})
          ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
        `;
        targets.applications = applications.map(({ id }) => id);
        targets.crossRepositoryApplications = applications.filter((item) => item.host !== request.host || item.repository_id !== request.repositoryId).length;
        if (targets.applications.length) {
          targets.events = (await sql<{ id: string }[]>`
            SELECT id FROM mitigation_application_events WHERE application_id IN ${sql(targets.applications)}
            ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
          `).map(({ id }) => id);
          targets.evaluations = (await sql<{ id: string }[]>`
            SELECT id FROM mitigation_evaluations WHERE application_id IN ${sql(targets.applications)}
            ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
          `).map(({ id }) => id);
        }
        targets.runs = (await sql<{ id: string }[]>`
          SELECT id FROM knowledge_run_observations WHERE host = ${request.host} AND repository_id = ${request.repositoryId}
          ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
        targets.snapshots = (await sql<{ id: string }[]>`
          SELECT id FROM knowledge_snapshots WHERE host = ${request.host} AND repository_id = ${request.repositoryId}
          ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
      } else {
        targets.runs = (await sql<{ id: string }[]>`
          WITH candidates AS (
            SELECT run_id FROM knowledge_run_observations
            WHERE host = ${request.host} AND repository_id = ${request.repositoryId}
            GROUP BY run_id HAVING max(observed_at) < ${new Date(request.before!)}
          )
          SELECT o.id FROM knowledge_run_observations o
          WHERE o.host = ${request.host} AND o.repository_id = ${request.repositoryId}
            AND o.run_id IN (SELECT run_id FROM candidates)
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_run_observations pinned
              WHERE pinned.host = o.host AND pinned.repository_id = o.repository_id AND pinned.run_id = o.run_id
                AND (EXISTS (SELECT 1 FROM mitigation_evaluation_samples s WHERE s.run_observation_id = pinned.id)
                  OR EXISTS (SELECT 1 FROM mitigation_application_events e WHERE e.run_observation_id = pinned.id))
            )
          ORDER BY o.id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
        targets.snapshots = (await sql<{ id: string }[]>`
          SELECT s.id FROM knowledge_snapshots s
          WHERE s.host = ${request.host} AND s.repository_id = ${request.repositoryId} AND s.collected_at < ${new Date(request.before!)}
            AND NOT EXISTS (SELECT 1 FROM mitigation_applications a WHERE a.topology_snapshot_id = s.id)
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_run_observations r WHERE r.source_snapshot_id = s.id
                ${targets.runs.length ? sql`AND r.id NOT IN ${sql(targets.runs)}` : sql``}
            )
          ORDER BY s.id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
      }
      if (targets.runs.length) {
        targets.executions = (await sql<{ id: string }[]>`
          SELECT id FROM knowledge_execution_observations WHERE run_observation_id IN ${sql(targets.runs)}
          ORDER BY id LIMIT ${MAINTENANCE_LIMIT + 1}
        `).map(({ id }) => id);
      }
      const plan = planMaintenance(request, targets);
      if (!plan.applied) return plan;
      if (targets.evaluations.length) {
        await sql`DELETE FROM mitigation_evaluation_samples WHERE evaluation_id IN ${sql(targets.evaluations)}`;
        await sql`DELETE FROM mitigation_evaluations WHERE id IN ${sql(targets.evaluations)}`;
      }
      if (targets.events.length) await sql`DELETE FROM mitigation_application_events WHERE id IN ${sql(targets.events)}`;
      if (targets.applications.length) {
        await sql`DELETE FROM mitigation_application_projects WHERE application_id IN ${sql(targets.applications)}`;
        await sql`DELETE FROM mitigation_applications WHERE id IN ${sql(targets.applications)}`;
      }
      if (targets.definitions.length) await sql`DELETE FROM mitigation_definitions WHERE id IN ${sql(targets.definitions)}`;
      if (targets.executions.length) await sql`DELETE FROM knowledge_execution_observations WHERE id IN ${sql(targets.executions)}`;
      if (targets.runs.length) await sql`DELETE FROM knowledge_run_observations WHERE id IN ${sql(targets.runs)}`;
      if (targets.snapshots.length) {
        await sql`DELETE FROM knowledge_relationships WHERE snapshot_id IN ${sql(targets.snapshots)}`;
        await sql`DELETE FROM knowledge_technologies WHERE snapshot_id IN ${sql(targets.snapshots)}`;
        await sql`DELETE FROM knowledge_projects WHERE snapshot_id IN ${sql(targets.snapshots)}`;
        await sql`DELETE FROM knowledge_snapshots WHERE id IN ${sql(targets.snapshots)}`;
      }
      return plan;
    });
  }

  async saveExecutionObservation(input: ExecutionObservation): Promise<void> {
    const item = structuredClone(input);
    validateExecutionObservation(item);
    await this.sql.begin(async (sql) => {
      const [row] = await sql<{ observation: RunObservation }[]>`
        SELECT observation FROM knowledge_run_observations
        WHERE id = ${item.runObservationId} AND host = ${item.repository.host} AND repository_id = ${item.repository.repositoryId}
      `;
      if (!row) throw new Error("Execution references unavailable run evidence");
      validateRunObservation(row.observation);
      validateExecutionObservation(item, row.observation);
      await sql`
        INSERT INTO knowledge_execution_observations (id, version, host, repository_id, run_observation_id, job_id, recorded_at, execution)
        VALUES (${item.id}, ${item.version}, ${item.repository.host}, ${item.repository.repositoryId}, ${item.runObservationId},
          ${item.jobId}, ${new Date(item.recordedAt)}, ${sql.json(JSON.parse(JSON.stringify(item)) as postgres.JSONValue)})
        ON CONFLICT (id) DO NOTHING
      `;
    });
  }
  async listExecutionObservations(scope: KnowledgeScope, runObservationId: string, limit: number): Promise<ExecutionObservation[]> {
    validateScope(scope); validateMitigationLimit(limit);
    if (!/^[a-f0-9]{64}$/.test(runObservationId)) throw new Error("Execution run observation ID is invalid");
    const rows = await this.sql<{ id: string; execution: ExecutionObservation }[]>`
      SELECT id, execution FROM knowledge_execution_observations
      WHERE host = ${scope.host} AND repository_id = ${scope.repositoryId} AND run_observation_id = ${runObservationId}
      ORDER BY recorded_at DESC, id LIMIT ${limit}
    `;
    for (const { id, execution } of rows) {
      validateExecutionObservation(execution);
      if (execution.id !== id || execution.repository.host !== scope.host || execution.repository.repositoryId !== scope.repositoryId ||
          execution.runObservationId !== runObservationId) throw new Error("Stored execution does not match its indexed scope");
    }
    return rows.map(({ execution }) => execution);
  }
  async loadMitigationDefinition(scope: KnowledgeScope, id: string): Promise<MitigationDefinition | undefined> {
    validateScope(scope);
    const [row] = await this.sql<{ definition: MitigationDefinition }[]>`
      SELECT definition FROM mitigation_definitions WHERE id = ${id} AND host = ${scope.host} AND repository_id = ${scope.repositoryId}
    `;
    if (!row) return undefined;
    validateMitigationDefinition(row.definition);
    if (row.definition.id !== id || row.definition.source.host !== scope.host || row.definition.source.repositoryId !== scope.repositoryId) {
      throw new Error("Stored mitigation definition does not match its indexed identity");
    }
    return row.definition;
  }
  async listMitigationDefinitions(scope: KnowledgeScope, limit: number): Promise<MitigationDefinition[]> {
    validateScope(scope); validateMitigationLimit(limit);
    const rows = await this.sql<{ definition: MitigationDefinition }[]>`
      SELECT definition FROM mitigation_definitions WHERE host = ${scope.host} AND repository_id = ${scope.repositoryId}
      ORDER BY definition_key, revision DESC, id LIMIT ${limit}
    `;
    for (const { definition } of rows) {
      validateMitigationDefinition(definition);
      if (definition.source.host !== scope.host || definition.source.repositoryId !== scope.repositoryId) {
        throw new Error("Stored mitigation definition does not match its indexed scope");
      }
    }
    return rows.map(({ definition }) => structuredClone(definition));
  }
  async saveMitigationApplication(input: MitigationApplication): Promise<void> {
    const application = structuredClone(input);
    validateMitigationApplication(application);
    await this.sql.begin(async (sql) => {
      const [definition] = await sql<{ id: string }[]>`SELECT id FROM mitigation_definitions WHERE id = ${application.definitionId}`;
      if (!definition) throw new Error("Mitigation application references an unknown definition revision");
      const [topology] = await sql<{ coverage: KnowledgeSnapshot["coverage"] }[]>`
        SELECT coverage FROM knowledge_snapshots
        WHERE id = ${application.topologySnapshotId} AND host = ${application.target.host} AND repository_id = ${application.target.repositoryId}
      `;
      if (!topology) throw new Error("Mitigation application topology snapshot is unavailable in the target repository");
      if (application.projectIds.length > 0) {
        const projects = await sql<{ id: string }[]>`
          SELECT id FROM knowledge_projects WHERE snapshot_id = ${application.topologySnapshotId}
            AND id IN ${sql(application.projectIds)}
        `;
        if (projects.length !== application.projectIds.length) throw new Error("Mitigation application projects must belong to its target topology snapshot");
      }
      const inserted = await sql`
        INSERT INTO mitigation_applications (id, version, host, repository_id, definition_id, topology_snapshot_id, change, created_at, application)
        VALUES (${application.id}, ${application.version}, ${application.target.host}, ${application.target.repositoryId},
          ${application.definitionId}, ${application.topologySnapshotId},
          ${sql.json(JSON.parse(JSON.stringify(application.change)) as postgres.JSONValue)},
          ${application.createdAt}, ${sql.json(JSON.parse(JSON.stringify(application)) as postgres.JSONValue)})
        ON CONFLICT (id) DO NOTHING RETURNING id
      `;
      if (inserted.length > 0 && application.projectIds.length > 0) {
        const projects = application.projectIds.map((projectId) => ({
          application_id: application.id, host: application.target.host, repository_id: application.target.repositoryId,
          topology_snapshot_id: application.topologySnapshotId, project_id: projectId,
        }));
        await sql`INSERT INTO mitigation_application_projects ${sql(projects, "application_id", "host", "repository_id", "topology_snapshot_id", "project_id")}`;
      }
    });
  }
  async loadMitigationApplication(scope: KnowledgeScope, id: string): Promise<MitigationApplication | undefined> {
    validateScope(scope);
    const [row] = await this.sql<{ application: MitigationApplication }[]>`
      SELECT application FROM mitigation_applications WHERE id = ${id} AND host = ${scope.host} AND repository_id = ${scope.repositoryId}
    `;
    if (!row) return undefined;
    validateMitigationApplication(row.application);
    const projects = await this.sql<{ project_id: string }[]>`
      SELECT project_id FROM mitigation_application_projects
      WHERE application_id = ${id} AND host = ${scope.host} AND repository_id = ${scope.repositoryId} ORDER BY project_id
    `;
    if (row.application.id !== id || row.application.target.host !== scope.host ||
        row.application.target.repositoryId !== scope.repositoryId ||
        JSON.stringify([...row.application.projectIds].sort()) !== JSON.stringify(projects.map(({ project_id }) => project_id))) {
      throw new Error("Stored mitigation application does not match its indexed identity");
    }
    return row.application;
  }
  async listMitigationApplications(scope: KnowledgeScope, limit: number): Promise<MitigationApplication[]> {
    validateScope(scope); validateMitigationLimit(limit);
    const rows = await this.sql<{ application: MitigationApplication }[]>`
      SELECT application FROM mitigation_applications WHERE host = ${scope.host} AND repository_id = ${scope.repositoryId}
      ORDER BY created_at DESC, id LIMIT ${limit}
    `;
    for (const { application } of rows) {
      validateMitigationApplication(application);
      if (application.target.host !== scope.host || application.target.repositoryId !== scope.repositoryId) {
        throw new Error("Stored mitigation application does not match its indexed scope");
      }
    }
    return rows.map(({ application }) => structuredClone(application));
  }
  async appendMitigationApplicationEvent(input: MitigationApplicationEvent): Promise<void> {
    const event = structuredClone(input);
    validateMitigationApplicationEvent(event);
    const [application] = await this.sql<{ created_at: Date }[]>`
      SELECT created_at FROM mitigation_applications
      WHERE id = ${event.applicationId} AND host = ${event.target.host} AND repository_id = ${event.target.repositoryId}
    `;
    if (!application) throw new Error("Mitigation event references an unknown target application");
    if (Date.parse(event.observedAt) < application.created_at.getTime()) throw new Error("Mitigation event predates its application");
    await this.sql`
      INSERT INTO mitigation_application_events (id, host, repository_id, application_id, observed_at, run_observation_id, event)
      VALUES (${event.id}, ${event.target.host}, ${event.target.repositoryId}, ${event.applicationId}, ${event.observedAt},
        ${event.runObservationId ?? null}, ${this.sql.json(JSON.parse(JSON.stringify(event)) as postgres.JSONValue)})
      ON CONFLICT (id) DO NOTHING
    `;
    const [row] = await this.sql<{ event: MitigationApplicationEvent }[]>`
      SELECT event FROM mitigation_application_events
      WHERE id = ${event.id} AND host = ${event.target.host} AND repository_id = ${event.target.repositoryId}
    `;
    if (!row) throw new Error("Mitigation application event was not persisted in the requested scope");
    validateMitigationApplicationEvent(row.event);
  }
  async listMitigationApplicationEvents(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationApplicationEvent[]> {
    validateScope(scope); validateMitigationLimit(limit); validateMitigationId(applicationId);
    const rows = await this.sql<{ event: MitigationApplicationEvent }[]>`
      SELECT event FROM mitigation_application_events
      WHERE host = ${scope.host} AND repository_id = ${scope.repositoryId} AND application_id = ${applicationId}
      ORDER BY observed_at DESC, id DESC LIMIT ${limit}
    `;
    for (const { event } of rows) {
      validateMitigationApplicationEvent(event);
      if (event.target.host !== scope.host || event.target.repositoryId !== scope.repositoryId || event.applicationId !== applicationId) {
        throw new Error("Stored mitigation event does not match its indexed scope");
      }
    }
    return rows.reverse().map(({ event }) => structuredClone(event));
  }
  async saveMitigationEvaluation(input: MitigationEvaluation): Promise<void> {
    const evaluation = structuredClone(input);
    validateMitigationEvaluation(evaluation);
    await this.sql.begin(async (sql) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      await sql`SET LOCAL statement_timeout = '10s'`;
      const [applicationRow] = await sql<{ application: MitigationApplication }[]>`
        SELECT application FROM mitigation_applications
        WHERE id = ${evaluation.applicationId} AND host = ${evaluation.target.host} AND repository_id = ${evaluation.target.repositoryId}
      `;
      if (!applicationRow) throw new Error("Mitigation evaluation references an unknown target application");
      const events = await sql<{ event: MitigationApplicationEvent }[]>`
        SELECT event FROM mitigation_application_events
        WHERE host = ${evaluation.target.host} AND repository_id = ${evaluation.target.repositoryId}
          AND application_id = ${evaluation.applicationId} AND observed_at <= ${evaluation.evaluatedAt}
      `;
      const ids = [...evaluation.controlObservationIds, ...evaluation.treatmentObservationIds];
      const allObservationIds = [...new Set(ids)];
      const selected = allObservationIds.length === 0 ? [] : await sql<{ observation: RunObservation }[]>`
        SELECT observation FROM knowledge_run_observations
        WHERE host = ${evaluation.target.host} AND repository_id = ${evaluation.target.repositoryId}
          AND id IN ${sql(allObservationIds)}
      `;
      if (selected.length !== allObservationIds.length) throw new Error("Mitigation evaluation references unavailable run evidence");
      const runIds = [...new Set(selected.map(({ observation }) => observation.run.runId))];
      const observations = runIds.length === 0 ? [] : (await sql<{ observation: RunObservation }[]>`
        SELECT observation FROM knowledge_run_observations
        WHERE host = ${evaluation.target.host} AND repository_id = ${evaluation.target.repositoryId}
          AND run_id IN ${sql(runIds)}
      `).map(({ observation }) => observation);
      verifyMitigationEvaluation(applicationRow.application, evaluation, events.map(({ event }) => event), observations);
      const inserted = await sql`
        INSERT INTO mitigation_evaluations (id, version, host, repository_id, application_id, evaluated_at, outcome, evaluation)
        VALUES (${evaluation.id}, ${evaluation.version}, ${evaluation.target.host}, ${evaluation.target.repositoryId},
          ${evaluation.applicationId}, ${evaluation.evaluatedAt}, ${evaluation.outcome},
          ${sql.json(JSON.parse(JSON.stringify(evaluation)) as postgres.JSONValue)})
        ON CONFLICT (id) DO NOTHING RETURNING id
      `;
      if (inserted.length > 0 && ids.length > 0) {
        const samples = [
          ...evaluation.controlObservationIds.map((run_observation_id) => ({
            evaluation_id: evaluation.id, host: evaluation.target.host, repository_id: evaluation.target.repositoryId,
            side: "control", run_observation_id,
          })),
          ...evaluation.treatmentObservationIds.map((run_observation_id) => ({
            evaluation_id: evaluation.id, host: evaluation.target.host, repository_id: evaluation.target.repositoryId,
            side: "treatment", run_observation_id,
          })),
        ];
        await sql`INSERT INTO mitigation_evaluation_samples ${sql(samples, "evaluation_id", "host", "repository_id", "side", "run_observation_id")}`;
      }
    });
  }
  async listMitigationEvaluations(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationEvaluation[]> {
    validateScope(scope); validateMitigationLimit(limit); validateMitigationId(applicationId);
    const rows = await this.sql<{ evaluation: MitigationEvaluation }[]>`
      SELECT evaluation FROM mitigation_evaluations
      WHERE host = ${scope.host} AND repository_id = ${scope.repositoryId} AND application_id = ${applicationId}
      ORDER BY evaluated_at DESC, id LIMIT ${limit}
    `;
    for (const { evaluation } of rows) {
      validateMitigationEvaluation(evaluation);
      if (evaluation.target.host !== scope.host || evaluation.target.repositoryId !== scope.repositoryId || evaluation.applicationId !== applicationId) {
        throw new Error("Stored mitigation evaluation does not match its indexed scope");
      }
    }
    return rows.map(({ evaluation }) => structuredClone(evaluation));
  }
}

function validateMitigationLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new Error("Mitigation evidence limit must be between 0 and 100");
}

function validateMitigationId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Mitigation evidence identity is invalid");
}
