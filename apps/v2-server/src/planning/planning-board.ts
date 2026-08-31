import {
  boardViewSchema,
  type ApprovedDeliveryPlan,
  type ApprovedIntentLedger,
  type BoardFilter,
  type BoardTaskCard,
  type BoardView,
  type ProjectId,
  type TaskReadiness,
  type TaskRevision,
} from '@mesh/v2-contracts';

export type BoardProjectionInput = Readonly<{
  projectId: ProjectId;
  intentLedger: ApprovedIntentLedger | null;
  deliveryPlan: ApprovedDeliveryPlan | null;
  currentTaskRevisions: readonly TaskRevision[];
  filter: BoardFilter | null;
}>;

const unicodeCompare = (left: string, right: string) => {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference =
      (a[index].codePointAt(0) ?? 0) - (b[index].codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const emptyFacets = () => ({
  milestones: [],
  taskLifecycles: [],
  readiness: [],
  priorities: [],
  labels: [],
  requirements: [],
});

const prePlanBoard = (
  projectId: ProjectId,
  emptyReason: 'intent_required' | 'planning_required',
): BoardView =>
  boardViewSchema.parse({
    projectId,
    deliveryPlanRevision: null,
    stale: false,
    emptyReason,
    filter: null,
    totalTaskCount: 0,
    matchedTaskCount: 0,
    facets: emptyFacets(),
    cards: [],
  });

type FacetName =
  | 'milestoneIds'
  | 'taskLifecycles'
  | 'readiness'
  | 'priorities'
  | 'labels'
  | 'requirementRecordIds';

export const projectBoard = (input: BoardProjectionInput): BoardView => {
  const {
    projectId,
    intentLedger,
    deliveryPlan,
    currentTaskRevisions,
    filter,
  } = input;
  if (deliveryPlan === null) {
    if (currentTaskRevisions.length !== 0 || filter !== null) {
      throw new Error(
        'Pre-plan Board cannot contain task revisions or a filter',
      );
    }
    return prePlanBoard(
      projectId,
      intentLedger === null ? 'intent_required' : 'planning_required',
    );
  }
  if (
    intentLedger === null ||
    filter === null ||
    deliveryPlan.plan.projectId !== projectId ||
    intentLedger.projectIntent.projectId !== projectId ||
    intentLedger.ledger.projectId !== projectId ||
    filter.projectId !== projectId
  ) {
    throw new Error('Board project, plan, ledger, and filter must agree');
  }

  const contracts = new Map(
    deliveryPlan.taskContracts.map((task) => [task.id, task] as const),
  );
  const current = new Map<string, TaskRevision>();
  for (const revision of currentTaskRevisions) {
    const anchor = contracts.get(revision.id);
    if (
      current.has(revision.id) ||
      anchor === undefined ||
      revision.projectId !== projectId ||
      revision.contractRevision !== anchor.revision ||
      revision.revision < anchor.revision
    ) {
      throw new Error('Current task revision selection is invalid');
    }
    const contractFields = [
      'milestoneId',
      'title',
      'outcome',
      'acceptanceCriteria',
      'verificationCriteria',
      'priority',
      'labels',
      'ownedSurfaces',
      'prohibitedSurfaces',
      'expectedArtifacts',
      'ordinal',
    ] as const;
    if (contractFields.some((field) => !same(revision[field], anchor[field]))) {
      throw new Error(
        'Current task revision does not match its contract anchor',
      );
    }
    current.set(revision.id, revision);
  }
  if (current.size !== contracts.size) {
    throw new Error('Current task revision selection is incomplete');
  }

  const milestones = new Map(
    deliveryPlan.milestones.map(
      (milestone) => [milestone.id, milestone] as const,
    ),
  );
  const records = new Map(
    intentLedger.records.map((record) => [record.recordId, record] as const),
  );
  const stale =
    deliveryPlan.plan.projectIntentId !== intentLedger.projectIntent.id ||
    deliveryPlan.plan.projectIntentRevision !==
      intentLedger.projectIntent.revision ||
    deliveryPlan.plan.ledgerId !== intentLedger.ledger.id ||
    deliveryPlan.plan.ledgerRevision !== intentLedger.ledger.revision;
  const activeDependencies = deliveryPlan.dependencies
    .filter(({ lifecycle }) => lifecycle === 'active')
    .sort((left, right) => unicodeCompare(left.id, right.id));

  const readinessFor = (task: TaskRevision): TaskReadiness => {
    const milestone = milestones.get(task.milestoneId);
    if (!milestone) throw new Error('Task milestone is absent from the plan');
    if (milestone.lifecycle === 'retired') {
      return {
        state: 'inactive',
        blockers: [{ kind: 'milestone_retired', milestoneId: milestone.id }],
      };
    }
    if (task.lifecycle === 'completed') {
      return { state: 'inactive', blockers: [{ kind: 'task_completed' }] };
    }
    if (task.lifecycle === 'retired') {
      return { state: 'inactive', blockers: [{ kind: 'task_retired' }] };
    }
    if (stale) {
      return {
        state: 'blocked',
        blockers: [
          {
            kind: 'plan_stale',
            expectedLedgerRevision: deliveryPlan.plan.ledgerRevision,
            actualLedgerRevision: intentLedger.ledger.revision,
          },
        ],
      };
    }
    const blockers = activeDependencies
      .filter(({ dependentTaskId }) => dependentTaskId === task.id)
      .flatMap((dependency) => {
        const prerequisite = current.get(dependency.prerequisiteTaskId);
        if (!prerequisite) throw new Error('Dependency endpoint is absent');
        return prerequisite.lifecycle === 'completed'
          ? []
          : [
              {
                kind: 'dependency_incomplete' as const,
                dependencyId: dependency.id,
                prerequisiteTaskId: dependency.prerequisiteTaskId,
              },
            ];
      });
    return blockers.length === 0
      ? { state: 'actionable', blockers: [] }
      : { state: 'blocked', blockers };
  };

  const cards = [...current.values()].map((task): BoardTaskCard => {
    const contract = contracts.get(task.id);
    const milestone = milestones.get(task.milestoneId);
    if (!contract || !milestone)
      throw new Error('Plan membership is incomplete');
    const dependencies = activeDependencies
      .flatMap((dependency) => {
        const prerequisite = dependency.prerequisiteTaskId === task.id;
        const dependent = dependency.dependentTaskId === task.id;
        if (!prerequisite && !dependent) return [];
        const otherId = prerequisite
          ? dependency.dependentTaskId
          : dependency.prerequisiteTaskId;
        const other = current.get(otherId);
        if (!other) throw new Error('Dependency endpoint is absent');
        return [
          {
            dependencyId: dependency.id,
            dependencyRevision: dependency.revision,
            direction: prerequisite
              ? ('dependent' as const)
              : ('prerequisite' as const),
            otherTaskId: other.id,
            otherTaskTitle: other.title,
            otherTaskLifecycle: other.lifecycle,
          },
        ];
      })
      .sort((left, right) =>
        unicodeCompare(left.dependencyId, right.dependencyId),
      );
    const requirementTraces = deliveryPlan.traces
      .flatMap((trace) => {
        if (trace.kind !== 'task_satisfies' || trace.taskId !== task.id)
          return [];
        const record = records.get(trace.requirement.recordId);
        if (
          !record ||
          record.revision !== trace.requirement.recordRevision ||
          record.content.type !== 'requirement'
        ) {
          throw new Error('Task requirement trace is invalid');
        }
        return [
          {
            recordId: record.recordId,
            recordRevision: record.revision,
            title: record.content.statement,
          },
        ];
      })
      .sort((left, right) => unicodeCompare(left.recordId, right.recordId));
    return {
      taskId: task.id,
      taskContractRevision: contract.revision,
      taskCurrentRevision: task.revision,
      milestoneId: milestone.id,
      milestoneRevision: milestone.revision,
      title: task.title,
      outcome: task.outcome,
      lifecycle: task.lifecycle,
      priority: task.priority,
      labels: task.labels,
      readiness: readinessFor(task),
      dependencies,
      detail: {
        acceptanceCriteria: task.acceptanceCriteria,
        verificationCriteria: task.verificationCriteria,
        ownedSurfaces: task.ownedSurfaces,
        prohibitedSurfaces: task.prohibitedSurfaces,
        expectedArtifacts: task.expectedArtifacts,
        milestoneOutcome: milestone.outcome,
        milestoneStopCondition: milestone.stopCondition,
        milestoneExclusions: milestone.exclusions,
        requirementTraces,
      },
    };
  });
  cards.sort((left, right) => {
    const milestoneDifference =
      (milestones.get(left.milestoneId)?.ordinal ?? 0) -
      (milestones.get(right.milestoneId)?.ordinal ?? 0);
    if (milestoneDifference !== 0) return milestoneDifference;
    const taskDifference =
      (current.get(left.taskId)?.ordinal ?? 0) -
      (current.get(right.taskId)?.ordinal ?? 0);
    return taskDifference || unicodeCompare(left.taskId, right.taskId);
  });

  const cardRequirements = (card: BoardTaskCard) =>
    card.detail.requirementTraces.map(({ recordId }) => recordId);
  const selected = (values: readonly string[], actual: readonly string[]) =>
    values.length === 0 || actual.some((value) => values.includes(value));
  const matches = (card: BoardTaskCard, omitted?: FacetName) =>
    (omitted === 'milestoneIds' ||
      selected(filter.milestoneIds, [card.milestoneId])) &&
    (omitted === 'taskLifecycles' ||
      selected(filter.taskLifecycles, [card.lifecycle])) &&
    (omitted === 'readiness' ||
      selected(filter.readiness, [card.readiness.state])) &&
    (omitted === 'priorities' ||
      selected(filter.priorities, [card.priority])) &&
    (omitted === 'labels' || selected(filter.labels, card.labels)) &&
    (omitted === 'requirementRecordIds' ||
      selected(filter.requirementRecordIds, cardRequirements(card)));
  const countWith = (
    field: FacetName,
    candidate: string,
    values: (card: BoardTaskCard) => readonly string[],
  ) =>
    cards.filter(
      (card) => matches(card, field) && values(card).includes(candidate),
    ).length;

  const milestoneOptions = [
    ...deliveryPlan.milestones.map((milestone) => ({
      value: milestone.id,
      label: milestone.title,
      selected: filter.milestoneIds.includes(milestone.id),
      matchingTaskCount: countWith('milestoneIds', milestone.id, (card) => [
        card.milestoneId,
      ]),
      milestoneRevision: milestone.revision,
      lifecycle: milestone.lifecycle,
      historical: false,
    })),
    ...filter.milestoneIds
      .filter((id) => !milestones.has(id))
      .map((id) => ({
        value: id,
        label: id,
        selected: true,
        matchingTaskCount: 0,
        milestoneRevision: 1,
        lifecycle: 'retired' as const,
        historical: true,
      })),
  ].sort((left, right) => unicodeCompare(left.value, right.value));
  const enumOptions = <T extends string>(
    values: readonly T[],
    field: FacetName,
    selectedValues: readonly T[],
    get: (card: BoardTaskCard) => T,
  ) =>
    values.map((value) => ({
      value,
      label: value,
      selected: selectedValues.includes(value),
      matchingTaskCount: countWith(field, value, (card) => [get(card)]),
    }));
  const currentLabels = new Set(cards.flatMap(({ labels }) => labels));
  const labelOptions = [...new Set([...currentLabels, ...filter.labels])]
    .sort(unicodeCompare)
    .map((value) => ({
      value,
      label: value,
      selected: filter.labels.includes(value),
      matchingTaskCount: currentLabels.has(value)
        ? countWith('labels', value, (card) => card.labels)
        : 0,
      historical: !currentLabels.has(value),
    }));
  const currentRequirementIds = new Set(
    deliveryPlan.traces.flatMap((trace) =>
      trace.kind === 'task_satisfies' ? [trace.requirement.recordId] : [],
    ),
  );
  const requirementOptions = [
    ...new Set([...currentRequirementIds, ...filter.requirementRecordIds]),
  ]
    .sort(unicodeCompare)
    .map((value) => {
      const record = records.get(value);
      const currentRequirement =
        currentRequirementIds.has(value) &&
        record?.content.type === 'requirement';
      return {
        value,
        label:
          record?.content.type === 'requirement'
            ? record.content.statement
            : value,
        selected: filter.requirementRecordIds.includes(value),
        matchingTaskCount: currentRequirement
          ? countWith('requirementRecordIds', value, cardRequirements)
          : 0,
        recordRevision: record?.revision ?? 1,
        requirementKind:
          record?.content.type === 'requirement'
            ? record.content.kind
            : ('functional' as const),
        historical: !currentRequirement,
      };
    });
  const matched = cards.filter((card) => matches(card));
  return boardViewSchema.parse({
    projectId,
    deliveryPlanRevision: deliveryPlan.plan.revision,
    stale,
    emptyReason:
      cards.length === 0
        ? 'plan_empty'
        : matched.length === 0
          ? 'filter_empty'
          : null,
    filter,
    totalTaskCount: cards.length,
    matchedTaskCount: matched.length,
    facets: {
      milestones: milestoneOptions,
      taskLifecycles: enumOptions(
        ['pending', 'completed', 'retired'],
        'taskLifecycles',
        filter.taskLifecycles,
        (card) => card.lifecycle,
      ),
      readiness: enumOptions(
        ['actionable', 'blocked', 'inactive'],
        'readiness',
        filter.readiness,
        (card) => card.readiness.state,
      ),
      priorities: enumOptions(
        ['must', 'should', 'could'],
        'priorities',
        filter.priorities,
        (card) => card.priority,
      ),
      labels: labelOptions,
      requirements: requirementOptions,
    },
    cards: matched,
  });
};
