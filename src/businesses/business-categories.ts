/**
 * Business type configures onboarding suggestions and defaults only. It never restricts
 * the core product model (guide section 1.1).
 */
export const BUSINESS_CATEGORIES = [
  { id: 'general_trader', label: 'General trader', suggestedUnits: ['piece', 'dozen', 'carton'] },
  { id: 'retail_shop', label: 'Retail shop', suggestedUnits: ['piece', 'pack', 'carton'] },
  {
    id: 'wholesale',
    label: 'Wholesaler or bulk seller',
    suggestedUnits: ['piece', 'carton', 'bag'],
  },
  {
    id: 'provision_store',
    label: 'Provision store or supermarket',
    suggestedUnits: ['piece', 'pack', 'carton'],
  },
  { id: 'foodstuff', label: 'Foodstuff seller', suggestedUnits: ['kg', 'bag', 'derica', 'congo'] },
  { id: 'beverages', label: 'Drinks and beverages', suggestedUnits: ['bottle', 'crate', 'carton'] },
  {
    id: 'pharmacy',
    label: 'Pharmacy and health products',
    suggestedUnits: ['piece', 'pack', 'box'],
  },
  { id: 'fashion', label: 'Fashion and textiles', suggestedUnits: ['piece', 'yard', 'bundle'] },
  { id: 'electronics', label: 'Electronics and phones', suggestedUnits: ['piece', 'box'] },
  { id: 'building', label: 'Building materials', suggestedUnits: ['piece', 'bag', 'bundle', 'kg'] },
  { id: 'services', label: 'Services', suggestedUnits: ['piece'] },
  { id: 'other', label: 'Other business', suggestedUnits: ['piece', 'kg', 'pack'] },
] as const;

export const BUSINESS_CATEGORY_IDS = BUSINESS_CATEGORIES.map((c) => c.id);
