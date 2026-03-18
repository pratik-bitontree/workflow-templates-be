/**
 * NodeMasterIds for built-in agents (from templates). All agents run in-process; no webhook.
 */
export const REDDIT_SEARCH_NODE_MASTER_ID = '694118a256220fc0c5e75ca7';
export const SEO_KEYWORDS_NODE_MASTER_ID = '698663321e9e291f191bd6ae';
export const IMAGE_SANITIZATION_NODE_MASTER_ID = '6979bb95bc551195e7d6ce8b';
export const CAROUSEL_PDF_NODE_MASTER_ID = '69468d152f2a9d0c3beee92b';

export const AGENT_NODE_MASTER_IDS = new Set([
  REDDIT_SEARCH_NODE_MASTER_ID,
  SEO_KEYWORDS_NODE_MASTER_ID,
  IMAGE_SANITIZATION_NODE_MASTER_ID,
  CAROUSEL_PDF_NODE_MASTER_ID,
]);

export function getAgentIdFromContext(nodeMasterId: unknown): string | null {
  if (nodeMasterId == null) return null;
  const anyId = nodeMasterId as any;
  const id =
    anyId?.metaData?.agentId ??
    anyId?.$oid ??
    anyId?._id?.toString?.() ??
    (typeof nodeMasterId === 'string' ? nodeMasterId : null) ??
    (typeof anyId?.toString === 'function' ? anyId.toString() : null);
  return id ? String(id).trim() : null;
}
