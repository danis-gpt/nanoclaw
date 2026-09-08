/** Host-only Idea → Feature mutation gate. */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyIdeaFeatureMutation } from './apply.js';
import { ideaFeatureMutation } from './guard.js';
import { requestIdeaFeatureHold, validateAndBindIdeaFeatureRequest } from './request.js';

registerDeliveryAction('idea_feature_request', applyIdeaFeatureMutation, {
  guardAction: ideaFeatureMutation,
  precheck: validateAndBindIdeaFeatureRequest,
  requestHold: requestIdeaFeatureHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `idea_feature_request denied: ${reason}`),
});

registerApprovalHandler('idea_feature_request', reenterGuardedDeliveryAction('idea_feature_request'));
