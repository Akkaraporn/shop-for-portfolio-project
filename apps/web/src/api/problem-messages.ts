import { NetworkError, ProblemError } from './client';

/**
 * What to tell a person when a request fails.
 *
 * Keyed on the problem's `type` slug and nothing else. The status code is shared by
 * many problems (five different things are a 409) and the English `title`/`detail`
 * may be reworded by either backend; the `type` URI is the one part docs/problem-types.md
 * publishes as stable, so it is the only thing safe to switch on.
 */
const MESSAGES: Record<string, string> = {
  'bad-request': 'คำขอไม่ถูกต้อง ลองรีเฟรชหน้าแล้วทำใหม่อีกครั้ง',
  unauthorized: 'กรุณาเข้าสู่ระบบอีกครั้ง',
  'invalid-credentials': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'token-reuse-detected': 'เพื่อความปลอดภัย ระบบได้ออกจากระบบให้ กรุณาเข้าสู่ระบบใหม่',
  forbidden: 'คุณไม่มีสิทธิ์เข้าถึงรายการนี้',
  'not-found': 'ไม่พบข้อมูลที่ต้องการ อาจถูกลบหรือย้ายไปแล้ว',
  conflict: 'ข้อมูลขัดแย้งกับที่มีอยู่แล้ว ลองรีเฟรชแล้วทำใหม่',
  'email-already-registered': 'อีเมลนี้ถูกใช้สมัครสมาชิกแล้ว',
  'insufficient-stock': 'สินค้าบางรายการไม่พอ กรุณาปรับจำนวน',
  'checkout-in-progress': 'กำลังดำเนินการอยู่ กรุณารอสักครู่',
  'order-not-cancellable': 'คำสั่งซื้อนี้ชำระเงินแล้ว จึงยกเลิกไม่ได้',
  'payment-not-confirmable': 'คำสั่งซื้อนี้ถูกยกเลิกหรือหมดเวลาแล้ว จึงชำระเงินไม่ได้',
  'invalid-transition': 'ไม่สามารถเปลี่ยนสถานะนี้ได้',
  'validation-failed': 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
  'invalid-cursor': 'รายการเปลี่ยนไประหว่างที่ดูอยู่ ลองโหลดหน้าใหม่',
  'idempotency-key-reused': 'คำสั่งซื้อนี้ถูกแก้ไขระหว่างส่ง กรุณาโหลดหน้าชำระเงินใหม่',
  'internal-error': 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่',
  'service-unavailable': 'ระบบไม่พร้อมให้บริการชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่',
  'backend-unavailable': 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้ในขณะนี้ ลองใหม่อีกครั้งในอีกสักครู่',
};

export const OFFLINE_MESSAGE = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
export const UNKNOWN_MESSAGE = 'มีบางอย่างผิดพลาด ลองใหม่อีกครั้ง';

export interface DescribedError {
  message: string;
  traceId?: string;
}

/**
 * A readable message for any thrown value, plus the traceId when there is one.
 *
 * An unknown `type` falls back to the problem's own English `title` — a new problem
 * type added to the contract is better shown in English than hidden behind a generic
 * "something went wrong".
 */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ProblemError) {
    return {
      message: MESSAGES[error.slug] ?? error.problem.title,
      traceId: error.traceId,
    };
  }
  if (error instanceof NetworkError) return { message: OFFLINE_MESSAGE };
  return { message: UNKNOWN_MESSAGE };
}

/** Exposed so a test can prove every slug in docs/problem-types.md has a message. */
export const KNOWN_SLUGS = Object.keys(MESSAGES);
