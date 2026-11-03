import { TrovyError } from '@trovyhq/sdk';

export interface ProjectMilestone {
  id?: string;
  reference: string;
  title: string;
  description: string | null;
  targetDate: string | null;
  clientVisible: boolean;
}

export interface ProjectDeliverable {
  id?: string;
  reference: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string[];
  clientVisible: boolean;
  milestoneRef: string | null;
  taskIds: string[];
}

export interface ProjectDeliveryStructure {
  structured: boolean;
  revision: number;
  canEdit: boolean;
  milestones: ProjectMilestone[];
  deliverables: ProjectDeliverable[];
}

export interface MilestoneChanges {
  title?: string;
  description?: string | null;
  targetDate?: string | null;
  clientVisible?: boolean;
}

/**
 * Narrow REST adapter for the project delivery structure. The published SDK
 * does not expose this endpoint yet; keep its request handling in one place.
 */
export class ProjectMilestoneClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(projectId: string): Promise<ProjectDeliveryStructure> {
    return this.request('GET', projectId);
  }

  async create(projectId: string, changes: MilestoneChanges): Promise<ProjectMilestone> {
    const current = await this.get(projectId);
    this.assertEditable(current);
    const reference = nextReference(current.milestones);
    const milestone: ProjectMilestone = {
      reference,
      title: requiredTitle(changes.title),
      description: normalizeDescription(changes.description),
      targetDate: normalizeDate(changes.targetDate),
      clientVisible: changes.clientVisible ?? false,
    };
    const saved = await this.replace(projectId, current, [...current.milestones, milestone]);
    return findMilestone(saved, reference);
  }

  async update(
    projectId: string,
    referenceOrId: string,
    changes: MilestoneChanges,
  ): Promise<ProjectMilestone> {
    if (Object.keys(changes).length === 0) {
      throw new Error('Provide at least one milestone field to update');
    }
    const current = await this.get(projectId);
    this.assertEditable(current);
    const target = findMilestone(current, referenceOrId);
    const updated: ProjectMilestone = {
      ...target,
      title: changes.title === undefined ? target.title : requiredTitle(changes.title),
      description:
        changes.description === undefined
          ? target.description
          : normalizeDescription(changes.description),
      targetDate:
        changes.targetDate === undefined
          ? target.targetDate
          : normalizeDate(changes.targetDate),
      clientVisible: changes.clientVisible ?? target.clientVisible,
    };
    const milestones = current.milestones.map((item) =>
      item.reference === target.reference ? updated : item,
    );
    const saved = await this.replace(projectId, current, milestones);
    return findMilestone(saved, target.id ?? target.reference);
  }

  async remove(projectId: string, referenceOrId: string): Promise<{
    reference: string;
    unlinkedDeliverables: number;
  }> {
    const current = await this.get(projectId);
    this.assertEditable(current);
    const target = findMilestone(current, referenceOrId);
    const unlinkedDeliverables = current.deliverables.filter(
      (item) => item.milestoneRef === target.reference,
    ).length;
    await this.replace(
      projectId,
      current,
      current.milestones.filter((item) => item.reference !== target.reference),
      current.deliverables.map((item) =>
        item.milestoneRef === target.reference ? { ...item, milestoneRef: null } : item,
      ),
    );
    return { reference: target.reference, unlinkedDeliverables };
  }

  private async replace(
    projectId: string,
    current: ProjectDeliveryStructure,
    milestones: ProjectMilestone[],
    deliverables: ProjectDeliverable[] = current.deliverables,
  ): Promise<ProjectDeliveryStructure> {
    return this.request('PATCH', projectId, {
      expectedRevision: current.revision,
      milestones: milestones.map((item) => ({
        ...item,
        targetDate: normalizeDate(item.targetDate),
      })),
      deliverables,
    });
  }

  private assertEditable(structure: ProjectDeliveryStructure): void {
    if (!structure.canEdit) throw new TrovyError('Project admin access is required', 403);
  }

  private async request(
    method: 'GET' | 'PATCH',
    projectId: string,
    body?: unknown,
  ): Promise<ProjectDeliveryStructure> {
    const url = `${this.apiUrl.replace(/\/$/, '')}/api/v1/projects/${encodeURIComponent(projectId)}/delivery-structure`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: this.apiUrl.replace(/\/$/, '') }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      throw new TrovyError(error instanceof Error ? error.message : 'Network error', 0);
    }
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.message === 'string'
        ? payload.message
        : `HTTP ${response.status}`;
      throw new TrovyError(message, response.status, payload);
    }
    const data = isRecord(payload) && payload.success === true ? payload.data : payload;
    if (!isStructure(data)) throw new TrovyError('Malformed delivery structure response', 502);
    return data;
  }
}

export function findMilestone(
  structure: ProjectDeliveryStructure,
  referenceOrId: string,
): ProjectMilestone {
  const query = referenceOrId.trim();
  const milestone = structure.milestones.find(
    (item) => item.id === query || item.reference === query.toUpperCase(),
  );
  if (!milestone) throw new TrovyError(`Milestone "${query}" not found in this project`, 404);
  return milestone;
}

function nextReference(milestones: ProjectMilestone[]): string {
  const used = new Set(milestones.map((item) => item.reference));
  for (let index = 1; index <= 100; index += 1) {
    const reference = `M${index}`;
    if (!used.has(reference)) return reference;
  }
  throw new Error('Project milestone limit reached');
}

function requiredTitle(value: string | undefined): string {
  const title = value?.trim() ?? '';
  if (title.length < 1 || title.length > 200) {
    throw new Error('Milestone title must contain 1 to 200 characters');
  }
  return title;
}

function normalizeDescription(value: string | null | undefined): string | null {
  const description = value?.trim() || null;
  if (description && description.length > 4_000) {
    throw new Error('Milestone description must not exceed 4000 characters');
  }
  return description;
}

/** The API reads ISO timestamps but only accepts date-only values on PATCH. */
function normalizeDate(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date ||
      (value.length !== 10 && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value))) {
    throw new Error('Milestone target date must use YYYY-MM-DD');
  }
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStructure(value: unknown): value is ProjectDeliveryStructure {
  return isRecord(value) &&
    Number.isInteger(value.revision) &&
    typeof value.canEdit === 'boolean' &&
    Array.isArray(value.milestones) &&
    Array.isArray(value.deliverables);
}
