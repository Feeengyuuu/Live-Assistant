# 未开播关注列表的数据来源

核对日期：2026-10-05（用户所在时区）。本次来源检查使用公开官方网页和脚本，没有读取或输出用户 Cookie。登录后返回值仍需在实际扩展中验证。

## 通用约束

- 请求失败、未登录、字段缺失、没有出现在直播列表中，都不能证明主播未开播。
- `offlineData` 只包含平台字段明确报告未开播的记录。原 `data` 数组及直播判断保留兼容性。
- `offlineCoverage: complete` 表示当前支持的直播关注来源已完整读取，不代表平台全部账号关注关系；没有直播间的普通账号不在此范围内。
- 分页共用 10 秒期限，最多读取 20 页。超时、达到页数上限、重复页或无效记录标为 `partial`，不能覆盖完整历史快照。
- `offlineFetchedAt` 仅在完整获取时返回，独立于直播列表的成功时间。

## 斗鱼

复用已有 `/wgapi/livenc/liveweb/follow/list` 分页结果，`show_status` 为数值或字符串 `2` 时才归入未开播。`videoLoop` 标识的轮播不因此归入未开播。

官方关注页 [directory/myFollow](https://www.douyu.com/directory/myFollow) 加载的 [follow 模块](https://shark2.douyucdn.cn/front-publish/live-master/js/list/follow~ad4f4577_be1b8b4.js) 使用相同关注接口，附带页数和排序参数。公开 [直播间信息接口示例](https://www.douyu.com/betard/99999) 返回已结束房间的 `show_status: 2`；正在直播的 [9999 房间](https://www.douyu.com/betard/9999) 返回 `show_status: 1`。这些状态是核对时的观察，后续可能变化。

## 虎牙

复用已有 `fw.huya.com/dispatch?do=subscribeList` 分页结果，只有明确的 `isLive: 0`、`"0"` 或 `false` 归入未开播。缺失值、其他值和轮播不通过取反推断状态。

官方 [我的关注页](https://www.huya.com/myFollow) 的 [subscribe-list 模块](https://a.msstatic.com/huya/main3/app/subscribe-list_1791686f.js) 将直播、重播、未开播分别渲染。本次没有借用其他用户的 UID 验证私人关注接口结果。

## 哔哩哔哩

已有 `GetWebList` 用于直播列表，不能据其缺席者推断未开播。新增独立消息 `getOfflineFollowedStreamers` 调用官方直播个人中心现用接口：

```text
https://api.live.bilibili.com/xlive/web-ucenter/user/following?page=1&page_size=9&ignoreRecord=1&hit_ab=false
```

一次辅助请求内部最多 20 页、180 条，不增加定时轮询。辅助请求失败不会更改已经成功的直播状态；真实认证失败会清除辅助列表，HTTP 403 则视为服务错误。

证据：

- 官方 [直播个人中心](https://link.bilibili.com/p/center/index) 当前加载的 [app 脚本](https://s1.hdslb.com/bfs/static/blive/blfe-link-center/static/js/app.1798ec0bcd4d3bc123e0.js) 定义该接口；参数包含 `page`、`page_size: 9`、`ignoreRecord: 1`，AB 分组默认回退为 `false`。
- 官方 [关注页面模块 61](https://s1.hdslb.com/bfs/static/blive/blfe-link-center/static/js/61.5aa608b9886c52745a89.js) 使用 `data.list`、`data.totalPage`、`data.count`、`data.live_count`；记录字段包含 `roomid`、`uname`、`face`、`live_status`、`area_name_v2`。
- app 脚本区分 `live_status` 的 `0`（preparing）、`1`（live）和 `2`（round）。本扩展只把明确的 `0` 放入未开播列表，轮播不混入。
- 官方页面另有 `never_lived_count` 和 `never_lived_faces` 汇总，不能据头像补造未开播账号或直播间。
- 不带登录资料实测该接口返回 `code: -101`；没有把匿名请求错误解释为空关注列表。

## 抖音与 Twitch

目前使用直播动态流和 Twitch 侧栏 Stream 查询，没有验证覆盖全部未开播关注者的来源，返回 `offlineSupported: false` 与 `offlineCoverage: unsupported`。不把动态流缺席、缺少房间信息或未识别节点当作未开播。

## 上次直播时间

- 斗鱼未开播记录的 `show_time`：公开官方 `betard/99999` 在核对时返回 `show_status: 2`、`show_time: 1689674245`、`end_time: "1689692621"`，对应上一场开播和结束时间。复用关注列表中同名字段，输出毫秒时间戳 `lastLiveAt` 与 `lastLiveSource: platform_start`，不增加逐房间查询。
- B 站官方关注模块使用 `record_live_time` 作为 Unix 秒时间戳，以当前时间相减并显示“几分钟前／昨天／某年某月某日直播了”。因此输出 `lastLiveSource: platform_record`，适用于“上次直播”文案，不能进一步断言是精确开播或结束时刻。
- 虎牙原数据的 `startTime` 保留供现有直播时长显示，但本次没有充分证据证明离线时该字段仍表示最近一场的开播时间，不据此补造 `lastLiveAt`。
- 只有 2000 年至当前时间之间的有效 Unix 秒被转换为 `lastLiveAt`；缺失、零值、持续时长和未来时间均省略。不会把 `live_time` 持续秒数当作上次直播日期。
