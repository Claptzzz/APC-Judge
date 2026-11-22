import { useMutation } from '@apollo/client/react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, TextField } from '../components/ui';
import { LOGIN, REGISTER } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { describeError } from '../lib/errors';

/** Solo se permite volver a rutas internas (evita redirecciones abiertas). */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/problems';
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <Card className="p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>
        {children}
      </Card>
    </div>
  );
}

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [login, { loading }] = useMutation(LOGIN);

  if (user) return <Navigate to={next} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { data } = await login({
        variables: { input: { usernameOrEmail: usernameOrEmail.trim(), password } },
      });
      if (!data) return;
      signIn(data.login);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        describeError(err, { UNAUTHENTICATED: 'Usuario o contraseña incorrectos.' }).message,
      );
    }
  };

  return (
    <AuthCard
      title="Iniciar sesión"
      subtitle="Entra para enviar soluciones, ver contests y usar el asistente."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField
          label="Usuario o email"
          name="usernameOrEmail"
          autoComplete="username"
          value={usernameOrEmail}
          onChange={(e) => setUsernameOrEmail(e.target.value)}
          required
        />
        <TextField
          label="Contraseña"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" loading={loading} disabled={!usernameOrEmail.trim() || !password}>
          Entrar
        </Button>
        <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
          ¿No tienes cuenta?{' '}
          <Link
            className="link"
            to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`}
          >
            Crea una
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

interface RegisterErrors {
  username?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

export function validateRegister(values: {
  username: string;
  email: string;
  password: string;
  confirm: string;
}): RegisterErrors {
  const errors: RegisterErrors = {};
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(values.username))
    errors.username = 'Entre 3 y 32 caracteres: letras, números, "_" o "-".';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Ingresa un email válido.';
  if (values.password.length < 8 || values.password.length > 128)
    errors.password = 'Entre 8 y 128 caracteres.';
  if (values.confirm !== values.password) errors.confirm = 'Las contraseñas no coinciden.';
  return errors;
}

export function RegisterPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [values, setValues] = useState({ username: '', email: '', password: '', confirm: '' });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [register, { loading }] = useMutation(REGISTER);

  if (user) return <Navigate to={next} replace />;

  const errors = validateRegister(values);
  const visibleErrors = touched ? errors : {};
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      const { data } = await register({
        variables: {
          input: {
            username: values.username.trim(),
            email: values.email.trim(),
            password: values.password,
          },
        },
      });
      if (!data) return;
      signIn(data.register);
      navigate(next, { replace: true });
    } catch (err) {
      const described = describeError(err, {
        CONFLICT: 'Ese nombre de usuario o email ya está registrado.',
      });
      setError(
        described.code === 'BAD_USER_INPUT' && described.detail
          ? `${described.message} (${described.detail})`
          : described.message,
      );
    }
  };

  return (
    <AuthCard title="Crear cuenta" subtitle="Tu cuenta parte como participante (CONTESTANT).">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField
          label="Nombre de usuario"
          name="username"
          autoComplete="username"
          value={values.username}
          onChange={set('username')}
          error={visibleErrors.username}
          hint="3 a 32 caracteres: letras, números, _ o -"
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={set('email')}
          error={visibleErrors.email}
        />
        <TextField
          label="Contraseña"
          name="password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          error={visibleErrors.password}
          hint="Mínimo 8 caracteres"
        />
        <TextField
          label="Repite la contraseña"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={values.confirm}
          onChange={set('confirm')}
          error={visibleErrors.confirm}
        />
        <Button type="submit" loading={loading}>
          Crear cuenta
        </Button>
        <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
          ¿Ya tienes cuenta?{' '}
          <Link className="link" to="/login">
            Inicia sesión
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
