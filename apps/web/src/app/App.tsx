import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth, RequireFamily } from './guards';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { JoinPage } from '../features/auth/JoinPage';
import { FamilyPickerPage } from '../features/families/FamilyPickerPage';
import { FamilyLayout } from '../features/families/FamilyLayout';
import { FamilyHomePage } from '../features/families/FamilyHomePage';
import { TimelinePage } from '../features/items/TimelinePage';
import { ItemListPage } from '../features/items/ItemListPage';
import { ItemDetailPage } from '../features/items/ItemDetailPage';
import { ItemFormPage } from '../features/items/ItemFormPage';
import { ItemPrintPage } from '../features/items/ItemPrintPage';
import { PeoplePage } from '../features/people/PeoplePage';
import { PersonDetailPage } from '../features/people/PersonDetailPage';
import { MembersPage } from '../features/members/MembersPage';
import { AuditPage } from '../features/audit/AuditPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TrashPage } from '../features/items/TrashPage';
import { ShareViewPage } from '../features/share/ShareViewPage';
import { RepairCenterPage } from '../features/repair/RepairCenterPage';

function NotFoundPage() {
  return (
    <div className="app-main">
      <div className="empty">
        <h3 className="empty__title">页面不存在</h3>
        <p className="empty__desc">链接可能已经失效，或者被移动过。</p>
        <a className="btn" href="/">
          回到首页
        </a>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/join/:code" element={<JoinPage />} />
      <Route path="/share/:token" element={<ShareViewPage />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <FamilyPickerPage />
          </RequireAuth>
        }
      />

      <Route
        path="/f/:fid"
        element={
          <RequireAuth>
            <RequireFamily>
              <FamilyLayout />
            </RequireFamily>
          </RequireAuth>
        }
      >
        <Route index element={<FamilyHomePage />} />
        <Route path="timeline" element={<TimelinePage />} />
        <Route path="items" element={<ItemListPage />} />
        <Route path="items/new" element={<ItemFormPage mode="create" />} />
        <Route path="items/:itemId" element={<ItemDetailPage />} />
        <Route path="items/:itemId/edit" element={<ItemFormPage mode="edit" />} />
        <Route path="items/:itemId/print" element={<ItemPrintPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="people/:personId" element={<PersonDetailPage />} />
        <Route
          path="members"
          element={
            <RequireFamily roles={['owner', 'admin']}>
              <MembersPage />
            </RequireFamily>
          }
        />
        <Route
          path="audit"
          element={
            <RequireFamily roles={['owner', 'admin']}>
              <AuditPage />
            </RequireFamily>
          }
        />
        <Route
          path="trash"
          element={
            <RequireFamily roles={['owner', 'admin']}>
              <TrashPage />
            </RequireFamily>
          }
        />
        <Route
          path="repairs"
          element={
            <RequireFamily roles={['owner', 'admin']}>
              <RepairCenterPage />
            </RequireFamily>
          }
        />
        <Route
          path="settings"
          element={
            <RequireFamily roles={['owner', 'admin']}>
              <SettingsPage />
            </RequireFamily>
          }
        />
      </Route>

      <Route path="/index.html" element={<Navigate to="/" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

