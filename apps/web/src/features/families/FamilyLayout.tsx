import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useFamily, canManageMembers } from './useFamily';
import { Avatar, Button } from '../../components/ui';

export function FamilyLayout() {
  const { fid } = useParams<{ fid: string }>();
  const { data } = useFamily(fid);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const role = data?.myRole;
  const navItems = [
    { to: `/f/${fid}`, label: '首页', end: true },
    { to: `/f/${fid}/timeline`, label: '时间轴' },
    { to: `/f/${fid}/items`, label: '物品' },
    { to: `/f/${fid}/people`, label: '人物' },
    { to: `/f/${fid}/members`, label: '成员', roles: ['owner', 'admin'] as const },
    { to: `/f/${fid}/audit`, label: '动态', roles: ['owner', 'admin'] as const },
    { to: `/f/${fid}/repair`, label: '媒体修复', roles: ['owner', 'admin'] as const },
    { to: `/f/${fid}/settings`, label: '设置', roles: ['owner', 'admin'] as const },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <NavLink to="/" className="brand">
            <span className="brand__mark" aria-hidden="true">
              册
            </span>
            <span>{data?.family.name ?? '家中物品来历册'}</span>
          </NavLink>
          <nav className="app-nav" aria-label="主导航">
            {navItems
              .filter((item) => !item.roles || (role && (item.roles as readonly string[]).includes(role)))
              .map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={'end' in item ? item.end : false}
                  className={({ isActive }) => `app-nav__link${isActive ? ' app-nav__link--active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
          </nav>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {user ? <Avatar name={user.displayName} color={user.avatarColor} size={32} /> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              退出
            </Button>
          </div>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

