import {
  createContext,
  useContext,
  useState,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { DEFAULT_THEME, type Theme } from './theme';
import { ThemeContext } from './useTheme';

const THEME_COLORS: Record<Theme, string> = {
  light: '#f6f7f2',
  dark: '#050608',
};

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLORS[theme];
}

/**
 * 主题状态的单一数据源。默认浅色；由页面级 <PageTheme> 在挂载/卸载时声明与复位。
 * 不监听路由——避免「路由复位」与「页面置主题」两个 effect 的父子时序竞态。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  return (
    <ThemeContext.Provider value={{ theme }}>
      <ThemeSetterContext.Provider value={setThemeState}>
        {children}
      </ThemeSetterContext.Provider>
    </ThemeContext.Provider>
  );
}

const ThemeSetterContext = createContext<((theme: Theme) => void) | null>(null);

/**
 * 由声明非默认主题的页面在其顶层渲染（如营销页 <PageTheme theme="dark" />）。
 *
 * 生命周期自洽：挂载时置该主题并同步 DOM，卸载（即离开该页）时复位为 DEFAULT_THEME。
 * 因为浅色页不渲染 PageTheme，「离开暗色页 = PageTheme 卸载 = 复位浅色」一步完成，
 * 不存在两个 effect 互相覆盖的竞态，也不会闪烁。
 */
export function PageTheme({ theme }: { theme: Theme }) {
  const setThemeState = useContext(ThemeSetterContext);
  if (!setThemeState) {
    throw new Error('PageTheme must be used within a ThemeProvider');
  }

  useLayoutEffect(() => {
    setThemeState(theme);
    applyTheme(theme);
    return () => {
      setThemeState(DEFAULT_THEME);
      applyTheme(DEFAULT_THEME);
    };
  }, [theme, setThemeState]);

  return null;
}
