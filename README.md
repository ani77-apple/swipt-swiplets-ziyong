# swipt-swiplets-ziyong

Swiplet 仓库源（**自用**）。

> ⚠️ **自用声明**
>
> 这是**个人自用**的 Swipt 仓库源，不是官方源，也不打算做成公共项目。
> 只在一台设备（iPhone，iOS 27.2）上验证过，改的规则是围着我本人常用的一批 App 补的，
> 别人装了不一定能用、也不保证后续维护。**不提供任何支持承诺。**
>
> 基于 [swipt-automation/official-swiplets](https://github.com/swipt-automation/official-swiplets)
> 修改而来，遵循 GPL-3.0-or-later（见 `LICENSE`）。

---

## 这是什么

一个可以加到 Swipt 里的**自定义仓库源**，目前只放了一个小应用：

| 小应用 | id | 与官方的关系 |
|---|---|---|
| 跳过广告 Plus | `skip-chinese-ads-plus` | 官方的 `skip-chinese-ads` 全量规则 + 本人的补充 |

**为什么用新 id 而不是直接改官方的**：官方那个 id 一更新就会把本地改动整个覆盖掉。
换成独立 id 后两边并存，官方照常升级，Plus 只管我加的那部分。

## 怎么用

1. Swipt → 小应用 → 添加 → **添加仓库**
2. 粘贴：

   ```
   https://raw.githubusercontent.com/ani77-apple/swipt-swiplets-ziyong/main/swiplets.json
   ```

3. 列表里出现「跳过广告 Plus」→ 安装
4. **把官方的「跳过广告」停掉**，两个同时开会在同一个 ✕ 上抢着点，日志会互相干扰

## 改了什么

### 一、规则表（`source/rules.ts`）

1. **新增 `com.weibo.international`（微博国际版）**
   它的跳过按钮**不暴露任何 class**，无障碍树里只有 `role=button / traits=[button] / label="跳过"`，
   官方那套按类名匹配的规则完全打不中。

2. **新增 `sdk.generic` / `sdk.genericTrait`**
   移植 GKD 订阅（`AIsouler/GKD_subscription`，`404` 组）的通用开屏规则语义：
   label 含 `跳过 / 跳過 / skip`，排除 `视频 / 片头 / 片尾 / 帮助 / 取消 / 退出 / 关闭 / 广告合作`。

3. **新增 `sdk.genericText`**
   iOS 上最常见的形态其实是 **UILabel**（`role=text`、`traits=[staticText]`、无 class）。
   识货、Keep、多彩宝、PICOOC、NB Pro、B612、百度网盘 全是这种，官方规则一条都覆盖不到。
   用锚定正则只认整串「跳过 / 跳过 6 / 跳过  05」，不会误伤正文里的「跳过」二字。

4. **新增 `sdk.countdownClose`**
   对付 `4s后自动关闭` 这种措辞（一码贵州）。

5. **新增 `sdk.skipIdentifier`**
   百度网盘的跳过按钮 label 为空，只有 `identifier="skipButton"`。

### 二、引擎（`source/extension.ts`）

6. **通用兜底规则改为对所有 App 生效**
   原逻辑是 `(fuzzy ? sdkRules : rules[app].flat())`——只要 App 在官方规则表里，
   **就完全吃不到任何兜底**。识货、Keep、中国移动、百度网盘、菜鸟都在表里，所以它们之前全没救。
   改成把 `genericRules` 追加到每个 App 的选择器尾部。

7. **`accessibility.tap` 失败后回退到 `input.tap`**
   元素点击有命中校验，坐标落到"没名字的子视图"就拒绝，而且**默认耗满 5 秒才报错**，
   正好把整个广告窗口耗光（一码贵州、Keep 都是这个毛病）。
   改为 800ms 超时就回退成原始坐标点击。

## 实测

| App | 控件形态 | 跳过耗时 |
|---|---|---|
| 微博国际版 | `button` / "跳过" / 无 class | 4.7s → **1.0s** |
| 识货 | UILabel "跳过" | 首次 2567ms，学会后 **966ms** |
| 中国移动 | UIButton "3 跳过" | **1225ms**（点击仅 26ms）|
| Keep | UILabel "跳过"（GDT 广告内） | **1822ms** |
| PICOOC | UILabel "跳过" | **5561ms** |
| 一码贵州 | UIButton "4s后自动关闭" | **3548ms** |

## 已知限制

- 只验证过我本人装的 App。你机器上如果某个 App 还是不跳，多半是又一种没见过的控件形态。
- 直播类开屏广告（带"进直播间领券"那种）关掉后有时弹不出「继续领奖励」，正常现象。
- 个别广告的关闭键对合成触摸完全不响应，需要拟人触摸（1pt 位移 + 90ms 时长）才能点掉。
- 微博国际版的规则只对**开屏**有效，信息流里的广告不处理。

## 重新构建

`source/` 里是改过的三个文件，放回 `official-swiplets` 的 `skip-chinese-ads/` 目录：

```bash
npm i --legacy-peer-deps        # 首次
swipt project build             # 产物在 dist/skip-chinese-ads-plus/
# Windows 没有 zip 命令，build 最后一步会 ENOENT，手动打包即可（Py 示例见下）
swipt project source dist/skip-chinese-ads-plus.swiplet   # 生成 swiplets.json
```

```python
import zipfile, os
root, out = 'dist/skip-chinese-ads-plus', 'dist/skip-chinese-ads-plus.swiplet'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f)
            z.write(p, os.path.relpath(p, root).replace('\\', '/'))
```

## 许可

GPL-3.0-or-later，与上游一致。上游版权归 nekohasekai <i@sekai.icu>。
