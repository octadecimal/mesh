import {
  DeliveryPlanningPane,
  PlanningPane,
  type DeliveryPlanningPaneProps,
  type PlanningPaneProps,
} from './PlanningPane';

export type IntentPlanningSurfaceProps = Omit<
  PlanningPaneProps,
  | 'surface'
  | 'reviewHref'
  | 'onReviewProposal'
  | 'onRequestRevision'
  | 'draftStorageKey'
  | 'composerFocusRequest'
>;

export type DeliveryPlanningSurfaceProps = Omit<
  DeliveryPlanningPaneProps,
  | 'surface'
  | 'projectId'
  | 'reviewHref'
  | 'onReviewProposal'
  | 'onRequestRevision'
  | 'draftStorageKey'
  | 'composerFocusRequest'
>;

export type PlansPaneProps = {
  projectId: string;
  intent: IntentPlanningSurfaceProps;
  intentHistory?: IntentPlanningSurfaceProps;
  deliveryPlan: DeliveryPlanningSurfaceProps;
  onRequestIntentRevision(): void;
  onRequestDeliveryPlanRevision(): void;
};

export function PlansPane({
  projectId,
  intent,
  intentHistory,
  deliveryPlan,
  onRequestIntentRevision,
  onRequestDeliveryPlanRevision,
}: PlansPaneProps) {
  return (
    <section className="v2-plans-pane" aria-labelledby="plans-heading">
      <h2 id="plans-heading">Plans</h2>
      {intentHistory ? (
        <PlanningPane {...intentHistory} surface="review" />
      ) : null}
      <PlanningPane
        {...intent}
        surface="review"
        onRequestRevision={onRequestIntentRevision}
      />
      <DeliveryPlanningPane
        {...deliveryPlan}
        projectId={projectId}
        surface="review"
        onRequestRevision={onRequestDeliveryPlanRevision}
      />
    </section>
  );
}
