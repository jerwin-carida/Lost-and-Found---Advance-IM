# Lost and Found Hub

Express 5 + Supabase (managed PostgreSQL).

## Configure Supabase

1. Create a Supabase project.
2. In the Supabase Dashboard, open **Connect** and choose **Session pooler**.
   This is the recommended choice for IPv4-only networks, including many mobile/network environments.
3. Copy the connection string and replace its password placeholder. URL-encode special characters in the password (`@` becomes `%40`). SSL is handled by the app, so you don't need `?sslmode=require`.
4. Copy `.env.example` to `.env` and put that string in `DATABASE_URL`.
5. Set strong, private values for `JWT_SECRET` and `ENCRYPTION_KEY`.
   - `JWT_SECRET`: at least 32 random bytes encoded as hex.
   - `ENCRYPTION_KEY`: exactly 32 random bytes encoded as hex (64 hex characters).
6. Run `npm install`, then `npm run db:check` to test the connection, then `npm run setup`, then `npm start`.
7. Open `http://localhost:3000`.

The setup script creates tables and starter data inside the Supabase database. It does not create a database.

## Deployment

Set `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, and optionally `PORT` in your hosting provider's environment-variable settings. Do not upload `.env` or commit it to Git. The server binds to `0.0.0.0` so a hosting platform can route traffic to it.

## Starter staff accounts

- `admin` / `admin123`
- `moderator` / `mod123`

Change these immediately and before exposing the app publicly. The app uses one database connection role; staff permissions are enforced by the Express authentication/authorization middleware, not separate PostgreSQL roles.

## Important

- `npm run setup` is intended for initial setup and is safe to re-run for the starter rows.
- Do not run destructive reset scripts against a production database.
- Back up your data before changing the schema.
