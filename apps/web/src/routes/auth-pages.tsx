import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { ProblemError } from '@/api/client';
import { login, register } from '@/auth/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Only same-site paths, so `?next=https://evil.example` cannot redirect off the shop. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

/** Field-level messages from a 422, keyed by field name. */
function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ProblemError)) return {};
  return Object.fromEntries((error.problem.errors ?? []).map((e) => [e.field, e.message]));
}

function Field({
  id,
  label,
  error,
  ...input
}: { id: string; label: string; error?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-md flex-col px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await login(String(form.get('email')), String(form.get('password')));
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  // Wrong password and unknown email are one identical response by design (task 2.2),
  // so this page must not try to tell them apart either.
  const invalid = error instanceof ProblemError && error.slug === 'invalid-credentials';

  return (
    <AuthCard title="เข้าสู่ระบบ" description="สินค้าในตะกร้าจะตามคุณมาหลังเข้าสู่ระบบ">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <Field id="email" name="email" type="email" label="อีเมล" autoComplete="email" required />
        <Field
          id="password"
          name="password"
          type="password"
          label="รหัสผ่าน"
          autoComplete="current-password"
          required
        />
        {invalid ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            อีเมลหรือรหัสผ่านไม่ถูกต้อง
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </Button>
        <p className="text-sm text-muted-foreground">
          ยังไม่มีบัญชี?{' '}
          <Link className="text-primary underline" to={`/register?${params.toString()}`}>
            สมัครสมาชิก
          </Link>
        </p>
        <p className="text-xs text-muted-foreground">
          บัญชีทดลอง: somchai@example.com / DemoPass123!
        </p>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await register(
        String(form.get('email')),
        String(form.get('password')),
        String(form.get('fullName')),
      );
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  const errors = fieldErrors(error);
  const taken = error instanceof ProblemError && error.slug === 'email-already-registered';

  return (
    <AuthCard title="สมัครสมาชิก" description="สมัครแล้วสินค้าในตะกร้าจะย้ายเข้าบัญชีให้อัตโนมัติ">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <Field id="fullName" name="fullName" label="ชื่อ-นามสกุล" autoComplete="name" error={errors.fullName} />
        <Field
          id="email"
          name="email"
          type="email"
          label="อีเมล"
          autoComplete="email"
          error={taken ? 'อีเมลนี้มีบัญชีอยู่แล้ว' : errors.email}
        />
        <Field
          id="password"
          name="password"
          type="password"
          label="รหัสผ่าน (อย่างน้อย 10 ตัวอักษร)"
          autoComplete="new-password"
          error={errors.password}
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'กำลังสมัคร…' : 'สมัครสมาชิก'}
        </Button>
        <p className="text-sm text-muted-foreground">
          มีบัญชีแล้ว?{' '}
          <Link className="text-primary underline" to={`/login?${params.toString()}`}>
            เข้าสู่ระบบ
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
