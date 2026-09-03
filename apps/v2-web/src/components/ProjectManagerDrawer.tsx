import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';

import { DeliveryPlanningPane, PlanningPane } from './PlanningPane';
import type {
  DeliveryPlanningSurfaceProps,
  IntentPlanningSurfaceProps,
} from './PlansPane';

export const PM_PINNED_STORAGE_KEY = 'mesh.v2.pm-pinned';
export type ProjectManagerSection = 'intent' | 'delivery-plan';
const narrowQuery = '(max-width: 56rem)';

export function pmDraftStorageKey(
  projectId: string,
  purpose: 'intent' | 'delivery_plan',
) {
  return `mesh.v2.pm-draft:${projectId}:${purpose}`;
}

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia(narrowQuery).matches,
  );

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia(narrowQuery);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  return narrow;
}

export function ProjectManagerDrawer({
  projectId,
  projectName,
  open,
  pinned,
  section,
  composerFocusRequest,
  onOpenChange,
  onPinnedChange,
  onSectionChange,
  onNavigate,
  intent,
  intentHistory,
  deliveryPlan,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  pinned: boolean;
  section: ProjectManagerSection;
  composerFocusRequest: number;
  onOpenChange(open: boolean): void;
  onPinnedChange(pinned: boolean): void;
  onSectionChange(section: ProjectManagerSection): void;
  onNavigate(href: string): void;
  intent: IntentPlanningSurfaceProps;
  intentHistory?: IntentPlanningSurfaceProps;
  deliveryPlan: DeliveryPlanningSurfaceProps;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const narrow = useNarrowViewport();
  const pinnedLayout = pinned && !narrow;
  const title = `Project manager · ${projectName}`;
  const reviewHref = `/projects/${encodeURIComponent(projectId)}/plans`;

  function changePinned(next: boolean) {
    localStorage.setItem(PM_PINNED_STORAGE_KEY, String(next));
    onPinnedChange(next);
  }

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      onClick={pinnedLayout ? () => onOpenChange(!open) : undefined}
    >
      Project manager
    </button>
  );
  const body = (
    <>
      <div className="v2-pm-drawer-header">
        <h2 id={titleId}>{title}</h2>
        <div>
          <button type="button" onClick={() => changePinned(!pinned)}>
            {pinned ? 'Unpin project manager' : 'Pin project manager'}
          </button>
          <button type="button" onClick={() => onOpenChange(false)}>
            Close project manager
          </button>
        </div>
      </div>
      <div role="tablist" aria-label="Project manager conversations">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'intent'}
          onClick={() => onSectionChange('intent')}
        >
          Intent
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'delivery-plan'}
          onClick={() => onSectionChange('delivery-plan')}
        >
          Delivery Plan
        </button>
      </div>
      {section === 'intent' ? (
        <div role="tabpanel" aria-label="Intent conversation">
          {intentHistory ? (
            <PlanningPane
              {...intentHistory}
              key={`${projectId}:intent-history`}
              surface="conversation"
              reviewHref={reviewHref}
              onReviewProposal={() => onNavigate(reviewHref)}
            />
          ) : null}
          <PlanningPane
            {...intent}
            key={`${projectId}:intent`}
            surface="conversation"
            reviewHref={reviewHref}
            onReviewProposal={() => onNavigate(reviewHref)}
            draftStorageKey={pmDraftStorageKey(projectId, 'intent')}
            composerFocusRequest={composerFocusRequest}
          />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Delivery Plan conversation">
          <DeliveryPlanningPane
            {...deliveryPlan}
            key={`${projectId}:delivery-plan`}
            projectId={projectId}
            surface="conversation"
            reviewHref={reviewHref}
            onReviewProposal={() => onNavigate(reviewHref)}
            draftStorageKey={pmDraftStorageKey(projectId, 'delivery_plan')}
            composerFocusRequest={composerFocusRequest}
          />
        </div>
      )}
    </>
  );

  if (pinnedLayout) {
    return (
      <div className={open ? 'v2-pm-drawer v2-pm-drawer-open' : 'v2-pm-drawer'}>
        {trigger}
        {open ? (
          <aside className="v2-pm-drawer-panel" aria-labelledby={titleId}>
            {body}
          </aside>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="v2-pm-drawer-overlay" />
        <Dialog.Content
          className="v2-pm-drawer-panel v2-pm-drawer-dialog"
          aria-describedby={undefined}
        >
          <Dialog.Title asChild>
            <span className="v2-dialog-title">{title}</span>
          </Dialog.Title>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
