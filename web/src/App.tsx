import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout.js';
import { Splash } from './pages/Splash.js';
import { Support } from './pages/Support.js';
import { Share } from './pages/Share.js';
import { Signin } from './pages/Signin.js';
import { Signup } from './pages/Signup.js';
import { MfaChallenge } from './pages/MfaChallenge.js';
import { Inbox } from './pages/Inbox.js';
import { Ticket } from './pages/Ticket.js';
import { Team } from './pages/Team.js';
import { TeamInvite } from './pages/TeamInvite.js';
import { Account } from './pages/Account.js';
import { AdminInstall } from './pages/AdminInstall.js';
import { AdminUsers } from './pages/AdminUsers.js';
import { InvitationLanding } from './pages/InvitationLanding.js';
import { getSession } from './api.js';

function RequireSession({ children }: { children: React.ReactNode }) {
  const session = getSession();
  if (!session) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="/support/:slug" element={<Support />} />
        <Route path="/share/:token" element={<Share />} />
        <Route path="/signin" element={<Signin />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/mfa-challenge" element={<MfaChallenge />} />
        <Route path="/admin/install" element={<AdminInstall />} />
        <Route path="/invitations/:invId" element={<InvitationLanding />} />

        <Route
          path="/inbox"
          element={
            <RequireSession>
              <Inbox />
            </RequireSession>
          }
        />
        <Route
          path="/tickets/:ticketId"
          element={
            <RequireSession>
              <Ticket />
            </RequireSession>
          }
        />
        <Route
          path="/team"
          element={
            <RequireSession>
              <Team />
            </RequireSession>
          }
        />
        <Route
          path="/team/invite"
          element={
            <RequireSession>
              <TeamInvite />
            </RequireSession>
          }
        />
        <Route
          path="/account"
          element={
            <RequireSession>
              <Account />
            </RequireSession>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireSession>
              <AdminUsers />
            </RequireSession>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
