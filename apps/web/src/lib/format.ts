/**
 * Money arrives as integer satang (ADR-002) and is divided exactly once, here, for
 * display. Nothing else in the frontend does arithmetic on a price in baht.
 */
const baht = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPrice(cents: number): string {
  return baht.format(cents / 100);
}

const dateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** The order statuses, in the words a shopper uses. */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: 'รอชำระเงิน',
  paid: 'ชำระเงินแล้ว',
  fulfilled: 'จัดส่งแล้ว',
  completed: 'สำเร็จ',
  cancelled: 'ยกเลิกแล้ว',
  expired: 'หมดเวลาชำระเงิน',
  payment_failed: 'ชำระเงินไม่สำเร็จ',
};
