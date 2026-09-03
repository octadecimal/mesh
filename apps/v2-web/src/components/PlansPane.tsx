import {
  DeliveryPlanningPane,
  PlanningPane,
  type DeliveryPlanningPaneProps,
  type PlanningPaneProps,
} from './PlanningPane';

export type IntentPlanningSurfaceProps = Omit<
  PlanningPaneProps,
  'surface' | 'reviewHref' | 'onReviewProposal' | 'draftStorageKey'
>;

export type DeliveryPlanningSurfaceProps = Omit<
  DeliveryPlanningPaneProps,
  | 'surface'
  | 'projectId'
  | 'reviewHref'
  | 'onReviewProposal'
  | 'draftStorageKey'
>;

export type PlansPaneProps = {
  projectId: string;
  intent: IntentPlanningSurfaceProps;
  intentHistory?: IntentPlanningSurfaceProps;
  deliveryPlan: DeliveryPlanningSurfaceProps;
};

export function PlansPane({
  projectId,
  intent,
  intentHistory,
  deliveryPlan,
}: PlansPaneProps) {
  return (
    <section className="v2-plans-pane" aria-labelledby="plans-heading">
      <h2 id="plans-heading">Plans</h2>
      {intentHistory ? (
        <PlanningPane {...intentHistory} surface="review" />
      ) : null}
      <PlanningPane {...intent} surface="review" />
      <DeliveryPlanningPane
        {...deliveryPlan}
        projectId={projectId}
        surface="review"
      />
    </section>
  );
}
