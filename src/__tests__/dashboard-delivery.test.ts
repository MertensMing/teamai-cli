import { describe, expect, it } from 'vitest';

import { diffDelivery, type Delivery } from '../dashboard/delivery.js';

/** How a preview reads two deliveries the way the next pull would carry the change out (#1124). */
describe('diffDelivery', () => {
  const none = { roles: null, projects: null };
  const delivery = (over: Partial<Delivery>): Delivery => ({
    namespaces: { skills: [], knowledge: [], agents: [], learnings: [] },
    skills: [], skillNamespaces: [], rules: [], heldSkills: [], ...over,
  });

  it('lists what enters and leaves', () => {
    const changed = diffDelivery(
      delivery({ namespaces: { skills: ['frontend'], knowledge: ['frontend'], agents: [], learnings: [] }, skills: ['ui-kit'], rules: ['frontend/ui', 'style'] }),
      delivery({ namespaces: { skills: ['backend'], knowledge: ['backend'], agents: [], learnings: [] }, skills: ['api-kit'], rules: ['backend/api', 'style'] }),
      none,
    );

    expect(changed.namespaces.skills).toEqual({ entering: ['backend'], leaving: ['frontend'] });
    expect(changed.skills).toEqual({ entering: ['api-kit'], leaving: ['ui-kit'], held: [] });
    expect(changed.rules).toEqual({ entering: ['backend/api'], leaving: ['frontend/ui'] });
  });

  it('treats an unfiltered side as receiving every namespace it declares or delivers from', () => {
    const roles = { version: 1, roles: [
      { id: 'frontend', description: '', resources: { knowledge: ['frontend'], skills: ['frontend'], agents: [] } },
      { id: 'backend', description: '', resources: { knowledge: ['backend'], skills: ['backend'], agents: [] } },
    ] };
    const changed = diffDelivery(
      delivery({ namespaces: null, skills: ['api-kit', 'pay-kit', 'ui-kit'], skillNamespaces: ['backend', 'frontend', 'payment'] }),
      delivery({ namespaces: { skills: ['frontend'], knowledge: ['frontend'], agents: [], learnings: [] }, skills: ['ui-kit'] }),
      { roles, projects: null },
    );

    expect(changed.unfiltered).toEqual({ before: true, after: false });
    expect(changed.namespaces.skills).toEqual({ entering: [], leaving: ['backend', 'payment'] });
    expect(changed.namespaces.knowledge).toEqual({ entering: [], leaving: ['backend'] });
  });

  it('does not count a held skill as leaving (#913)', () => {
    const changed = diffDelivery(delivery({ skills: ['shared', 'ui-kit'] }), delivery({ skills: ['api-kit', 'ui-kit'], heldSkills: ['shared'] }), none);

    expect(changed.skills).toEqual({ entering: ['api-kit'], leaving: [], held: ['shared'] });
  });

  it('leaves skills unchanged when the new selection has a skill conflict, as pull does', () => {
    const changed = diffDelivery(delivery({ skills: ['ui-kit'] }), delivery({ skillConflict: 'Duplicate skill "x"' }), none);

    expect(changed.skills).toEqual({ entering: [], leaving: [], held: [] });
    expect(changed.skillConflict).toBe('Duplicate skill "x"');
  });
});
