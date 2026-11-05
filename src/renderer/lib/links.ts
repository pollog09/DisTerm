export interface MobileStoreLink {
  id: 'app-store' | 'google-play'
  /** Button / link text. */
  label: string
  /** How prose names the store ("Grab it from the App Store"). */
  prose: string
  url: string
}

/**
 * Where to get the mobile app, in display order: nowhere. The mobile apps are upstream's and speak
 * to a relay DisTerm does not run, so no surface advertises them. One home so every surface that
 * could show a store link shows none, and renders nothing for an empty list.
 */
export function mobileStoreLinks(): MobileStoreLink[] {
  return []
}

/** How the license copy names the stores a Pro subscription may have been bought from. A fact about
 *  a purchase, not a link to one. */
export function mobileStoreNames(): string {
  return 'the App Store or Google Play'
}

/**
 * Stripe's hosted billing page for desktop (Stripe checkout) Pro buyers: the buyer signs in with
 * their checkout email and gets their invoices, payment method and cancellation. App Store / Play
 * purchases are billed by the store and have nothing here.
 */
export const STRIPE_BILLING_PORTAL_URL = 'https://billing.stripe.com/p/login/9B65kFeraflH9ora4A7EQ00'
