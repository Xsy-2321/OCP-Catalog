import type { SessionView, MerchantOrderSummary } from '../public/contracts.js';
import { createPageState, deriveViewModel } from '../public/view-model.js';
import { getControl } from '../public/dom.js';

declare const session: SessionView;
declare const summary: MerchantOrderSummary;

// These cases fail the build if checkJs or shared DTO types stop checking fields.
// @ts-expect-error Private runtime identity is not a page response field.
session.user_id;
// @ts-expect-error Purchase signing/idempotency data must not enter browser views.
session.attempt?.idempotency_key;
// @ts-expect-error Recipient details belong to the order detail response only.
summary.fulfillment.delivery;

const state = createPageState();
// @ts-expect-error Draft quantities are numbers, not unchecked form text.
state.draft.quantity = '2';
// @ts-expect-error Response revisions must remain numbers.
session.revision = 'old';
// @ts-expect-error A view model action is a boolean, not a DOM element.
deriveViewModel(state, Date.now()).actions.confirm.disabled;
// @ts-expect-error Controls must be narrowed to an input before checking a checkbox.
getControl('mixed-basket').checked;
