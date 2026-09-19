/*
 * 全站统一导航
 * ---------------------------------------------------------------------------
 * 四个页面（首页 / 如何使用 / 使用规则 / 用户协议）都引这一个文件，
 * 保证「左侧站内链接」和「右上角账号区」在各页长得完全一样。
 *
 * 之前每个页面各写一套，导致右上角有的页有三个按钮、有的页一个都没有，
 * 登录状态也互不相通 —— 这个文件的唯一目的就是消掉这种不一致。
 *
 * 用法：
 *   首页（单页应用，切视图不刷新）：
 *     renderSiteLinks('nav-links', null)
 *     renderSiteCta('nav-cta', state.user, { active: state.view, hooks: {...} })
 *
 *   静态页（如何使用 / 使用规则 / 用户协议）：
 *     initSiteNav('how' | 'rules' | 'terms')
 *     它会自己查一次 /api/me 再决定渲染哪套按钮。
 */
(function () {
  // 左侧站内链接。首页那条约指向锚点，点它应滚到「功能」区而不是整页跳转。
  var LINKS = [
    { key: 'features', label: '功能', href: '/#features' },
    { key: 'how', label: '如何使用', href: '/how' },
    { key: 'rules', label: '使用规则', href: '/rules' },
    { key: 'terms', label: '用户协议', href: '/terms' }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function btn(label, primary, href, opts) {
    opts = opts || {};
    var a = el('a', 'btn btn-sm' + (primary ? ' btn-primary' : ''), label);
    a.href = href;
    if (opts.hook || opts.onClick) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        (opts.onClick || opts.hook)(e);
      });
    }
    return a;
  }

  /** 左侧站内链接；current 用于高亮当前页（静态页传 'how' / 'rules' / 'terms'） */
  window.renderSiteLinks = function (boxId, current) {
    var box = document.getElementById(boxId || 'nav-links');
    if (!box) return;
    box.textContent = '';
    LINKS.forEach(function (L) {
      var a = el('a', L.key === current ? 'active' : '', L.label);
      a.href = L.href;
      if (L.key === current) a.setAttribute('aria-current', 'page');
      box.appendChild(a);
    });
  };

  /**
   * 右上角账号区。
   * @param {string}      boxId  容器 id
   * @param {string|null} user   已登录的用户名；null / 空 = 未登录
   * @param {object}      opts   active: 当前视图，决定哪个按钮是深色
   *                             hooks:  覆盖默认跳转（首页靠它切视图而不刷新）
   */
  window.renderSiteCta = function (boxId, user, opts) {
    opts = opts || {};
    var hooks = opts.hooks || {};
    var active = opts.active || null;
    var box = document.getElementById(boxId || 'nav-cta');
    if (!box) return;
    box.textContent = '';

    if (user) {
      box.appendChild(btn('首页', active === 'landing', '/', { hook: hooks.home }));
      box.appendChild(btn('控制台', active === 'dash', '/#/dash', { hook: hooks.dash }));

      // 当前登录的用户名，放在「退出」左边
      var who = el('span', 'nav-who', user);
      who.title = '当前登录账号：' + user;
      box.appendChild(who);

      box.appendChild(btn('退出', false, '#', {
        onClick: function () {
          fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
            .then(function () { if (hooks.logout) hooks.logout(); else location.href = '/'; })
            .catch(function () { if (hooks.logout) hooks.logout(); else location.href = '/'; });
        }
      }));
    } else {
      box.appendChild(btn('登录', active === 'login', '/#/login', { hook: hooks.login }));
      box.appendChild(btn('免费注册', active === 'landing' || active === 'register', '/#/register', { hook: hooks.register }));
    }
  };

  /** 静态页入口：渲染左侧链接 + 查登录状态后渲染右上角 */
  window.initSiteNav = function (current) {
    window.renderSiteLinks('nav-links', current || null);
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { window.renderSiteCta('nav-cta', m && m.username, {}); })
      .catch(function () { window.renderSiteCta('nav-cta', null, {}); });
  };
})();