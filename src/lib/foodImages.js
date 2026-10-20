/* ═══════════════════════════════════════════════════════════════════════
   Food Images · 真实美食图片映射
   ─────────────────────────────────────────────────────────────────────
   为每个内置条目匹配一张真实美食摄影图。按名称关键词匹配，
   没有命中关键词的条目会回退到程序化占位图（FoodImage 组件）。

   图片统一风格：暗调背景、戏剧化侧光、食物表面带油润光泽和蒸汽。
   存于 public/food/ 目录，构建后可通过 /food/<name>.jpg 访问。
   ═══════════════════════════════════════════════════════════════════════ */

const IMAGE_MAP = {
  /* ═══════════════════════════════════════════════════════════════════
     2026-10-20：55 道菜**一菜一图**（AI 生成，已裁掉平台水印）
     ───────────────────────────────────────────────────────────────────
     在之前，55 道菜共用 15 张图 —— 光 noodles.jpg 就被 13 道面食共用，
     「兰州牛肉面」和「重庆小面」显示的是同一张照片；店名更是全落到占位图。
     这一组是专属图，文件在 public/food/dish/<slug>.jpg（1024×950，110–200KB）。

     ⚠️ 两条规矩：
     1. 这些是**精确匹配**，必须放在关键词兜底之前（位置就在表头）。
     2. 以后加新菜：先看能不能命中关键词；要专属图就生成一张、
        存进 dish/、在这里加一行。**别把两道菜指向同一个文件**。
     ═══════════════════════════════════════════════════════════════════ */
  云南过桥米线: '/food/dish/yunnan-mixian.jpg',
  兰州牛肉面: '/food/dish/lanzhou-niuroumian.jpg',
  冒菜: '/food/dish/maocai.jpg',
  北京炸酱面: '/food/dish/beijing-zhajiangmian.jpg',
  南昌拌粉: '/food/dish/nanchang-banfen.jpg',
  卤肉饭: '/food/dish/lurou-fan.jpg',
  口水鸡: '/food/dish/koushui-ji.jpg',
  咖喱鸡肉饭: '/food/dish/curry-chicken-rice.jpg',
  回锅肉: '/food/dish/huiguo-rou.jpg',
  奥尔良烤鸡腿: '/food/dish/orleans-chicken-leg.jpg',
  宫保鸡丁: '/food/dish/gongbao-jiding.jpg',
  寿司拼盘: '/food/dish/sushi-platter.jpg',
  小笼包: '/food/dish/xiaolongbao.jpg',
  山西刀削面: '/food/dish/shanxi-daoxiaomian.jpg',
  广式煲仔饭: '/food/dish/claypot-rice.jpg',
  意大利面: '/food/dish/spaghetti.jpg',
  扬州炒饭: '/food/dish/yangzhou-chaofan.jpg',
  披萨: '/food/dish/pizza.jpg',
  担担面: '/food/dish/dandanmian.jpg',
  新疆手抓饭: '/food/dish/xinjiang-shizhua-fan.jpg',
  桂林米粉: '/food/dish/guilin-mifen.jpg',
  武汉热干面: '/food/dish/wuhan-reganmian.jpg',
  水煮肉片: '/food/dish/shuizhu-roupian.jpg',
  海南鸡饭: '/food/dish/hainan-jifan.jpg',
  清蒸鲈鱼: '/food/dish/steamed-seabass.jpg',
  炸鸡桶: '/food/dish/fried-chicken-bucket.jpg',
  烤五花肉: '/food/dish/grilled-pork-belly.jpg',
  煎饼果子: '/food/dish/jianbing.jpg',
  照烧鸡排饭: '/food/dish/teriyaki-chicken-rice.jpg',
  猪肉白菜饺子: '/food/dish/pork-cabbage-dumplings.jpg',
  玉米排骨汤: '/food/dish/corn-rib-soup.jpg',
  生煎包: '/food/dish/shengjianbao.jpg',
  番茄鸡蛋面: '/food/dish/tomato-egg-noodles.jpg',
  白切鸡: '/food/dish/white-cut-chicken.jpg',
  皮蛋瘦肉粥: '/food/dish/century-egg-congee.jpg',
  石锅拌饭: '/food/dish/bibimbap.jpg',
  羊肉串: '/food/dish/lamb-skewers.jpg',
  肉夹馍: '/food/dish/roujiamo.jpg',
  芝士焗饭: '/food/dish/cheese-baked-rice.jpg',
  薯条: '/food/dish/french-fries.jpg',
  藤椒鸡排: '/food/dish/rattan-pepper-chicken.jpg',
  蛋炒饭: '/food/dish/egg-fried-rice.jpg',
  螺蛳粉: '/food/dish/luosifen.jpg',
  辣子鸡: '/food/dish/laziji.jpg',
  酸菜鱼: '/food/dish/suancai-yu.jpg',
  酸辣粉: '/food/dish/suanlafen.jpg',
  重庆小面: '/food/dish/chongqing-xiaomian.jpg',
  重庆火锅: '/food/dish/chongqing-hotpot.jpg',
  陕西油泼面: '/food/dish/youpo-mian.jpg',
  香辣鸡腿堡: '/food/dish/spicy-chicken-burger.jpg',
  鲜虾云吞面: '/food/dish/shrimp-wonton-noodles.jpg',
  鸡肉卷: '/food/dish/chicken-wrap.jpg',
  麻婆豆腐: '/food/dish/mapo-tofu.jpg',
  麻辣香锅: '/food/dish/mala-xiangguo.jpg',
  黄焖鸡米饭: '/food/dish/huangmenji.jpg',

  // 精确匹配（旧：店名 + 旧菜名 —— 关键词兜底之前先命中这些）
  三鲜馄饨: '/food/noodles.jpg',
  猪脚饭: '/food/pork.jpg',
  酸奶水果捞: '/food/dessert.jpg',
  蒸饺: '/food/dumpling.jpg',
  水煮牛肉: '/food/beef.jpg',
  麻辣小龙虾: '/food/seafood.jpg',
  变态辣鸡翅: '/food/chicken.jpg',
  手抓饼: '/food/dessert.jpg',
  关东煮: '/food/dessert.jpg',
  沙县小吃: '/food/dessert.jpg',
  张亮麻辣烫: '/food/spicy.jpg',
  遇见小面: '/food/noodles.jpg',
  喜家德虾仁水饺: '/food/dumpling.jpg',
  乡村基: '/food/chicken.jpg',
  大米先生: '/food/rice.jpg',
  木屋烧烤: '/food/bbq.jpg',
  阿香米线: '/food/noodles.jpg',
  眉州东坡: '/food/spicy.jpg',
  费大厨辣椒炒肉: '/food/spicy.jpg',
  曼玲粥店: '/food/congee.jpg',
  紫燕百味鸡: '/food/chicken.jpg',
  三顾冒菜: '/food/spicy.jpg',
  犟骨头排骨饭: '/food/pork.jpg',

  // 关键词匹配（兜底）
  粥: '/food/congee.jpg',
  汤: '/food/soup.jpg',
  馄饨: '/food/noodles.jpg',
  云吞: '/food/noodles.jpg',
  面: '/food/noodles.jpg',
  粉: '/food/noodles.jpg',
  饼: '/food/dessert.jpg',
  饺: '/food/dumpling.jpg',
  鱼: '/food/fish.jpg',
  虾: '/food/seafood.jpg',
  海鲜: '/food/seafood.jpg',
  鲈: '/food/fish.jpg',
  鸡: '/food/chicken.jpg',
  翅: '/food/chicken.jpg',
  腿: '/food/chicken.jpg',
  猪: '/food/pork.jpg',
  排骨: '/food/pork.jpg',
  牛: '/food/beef.jpg',
  /* ⚠️ 当初生成图片时漏了 meat.jpg —— 落到「肉」这条关键词的条目
     （比如用户自己加的「红烧肉」）用 pork.jpg 顶上。
     **别写回 '/food/meat.jpg'**，那个文件不存在，会显示破图。 */
  肉: '/food/pork.jpg',
  饭: '/food/rice.jpg',
  炒: '/food/rice.jpg',
  辣: '/food/spicy.jpg',
  麻: '/food/spicy.jpg',
  香锅: '/food/spicy.jpg',
  水煮: '/food/spicy.jpg',
  螺蛳: '/food/spicy.jpg',
  酸辣: '/food/spicy.jpg',
  水果: '/food/dessert.jpg',
  酸奶: '/food/dessert.jpg',
  甜: '/food/dessert.jpg',
  夹馍: '/food/dessert.jpg',
  烧烤: '/food/bbq.jpg',
  烤: '/food/bbq.jpg',

  /* ═══════════════════════════════════════════════════════════════════
     2026-10-20 扩充（Day 25 · 甲方案）
     ───────────────────────────────────────────────────────────────────
     原来的表只覆盖「中式正餐 / 面食 / 辣菜」，可外卖里最常见的
     **快餐、火锅、日料、韩餐、饮品、早餐** 全都查不到 → 只能落抽象占位图。
     这就是"新加的菜没有图片"的直接原因。

     ⚠️ 两条规矩（别破坏）：
     1. **只用具体词，不用单字** —— 关键词是按长度降序匹配的，单字很脏：
        写「炸」会让「炸酱面」变成炸鸡图，写「锅」会让「锅包肉」变成火锅图。
     2. **这里出现的每个 /food/xxx.jpg 都必须真实存在** —— 少一张就是破图。
        pizza / sushi 是 Day 25 新加的（AI 生成后裁掉水印、压成 jpg）。
     ═══════════════════════════════════════════════════════════════════ */

  // 火锅 / 涮锅：红油视觉和「辣菜」最接近
  火锅: '/food/spicy.jpg',
  涮锅: '/food/spicy.jpg',
  麻辣锅: '/food/spicy.jpg',
  海底捞: '/food/spicy.jpg',
  小龙坎: '/food/spicy.jpg',
  呷哺: '/food/spicy.jpg',
  部队锅: '/food/spicy.jpg',
  砂锅粥: '/food/congee.jpg', // 比「砂锅」长，优先命中
  砂锅: '/food/soup.jpg',

  // 西式快餐 / 炸物
  汉堡: '/food/chicken.jpg',
  炸鸡: '/food/chicken.jpg',
  鸡翅: '/food/chicken.jpg',
  鸡腿: '/food/chicken.jpg',
  麦当劳: '/food/chicken.jpg',
  肯德基: '/food/chicken.jpg',
  德克士: '/food/chicken.jpg',
  华莱士: '/food/chicken.jpg',
  汉堡王: '/food/chicken.jpg',

  // 披萨
  比萨: '/food/pizza.jpg',
  必胜客: '/food/pizza.jpg',
  达美乐: '/food/pizza.jpg',

  // 日料
  寿司: '/food/sushi.jpg',
  刺身: '/food/sushi.jpg',
  三文鱼: '/food/sushi.jpg',
  日料: '/food/sushi.jpg',
  味千: '/food/noodles.jpg',

  // 韩式
  拌饭: '/food/rice.jpg',
  石锅: '/food/spicy.jpg',
  泡菜: '/food/spicy.jpg',
  年糕: '/food/spicy.jpg',

  // 饮品 / 甜品
  奶茶: '/food/dessert.jpg',
  咖啡: '/food/dessert.jpg',
  果汁: '/food/dessert.jpg',
  蛋糕: '/food/dessert.jpg',
  冰淇淋: '/food/dessert.jpg',

  // 早餐 / 面点
  包子: '/food/dumpling.jpg',
  小笼: '/food/dumpling.jpg',
  灌汤包: '/food/dumpling.jpg',
  生煎: '/food/dumpling.jpg',
  油条: '/food/dumpling.jpg',
  豆浆: '/food/congee.jpg',
  煎饼: '/food/dumpling.jpg',
  肠粉: '/food/noodles.jpg',
  早点: '/food/dumpling.jpg',

  // 卤味 / 禽肉
  卤肉: '/food/pork.jpg',
  烤鸭: '/food/bbq.jpg',
  鸭脖: '/food/chicken.jpg',
  鹅: '/food/chicken.jpg',
  羊肉: '/food/beef.jpg',
  羊蝎: '/food/beef.jpg',
  羊排: '/food/beef.jpg',

  // 常见连锁品牌（外卖里常被直接当菜名加，比如库里那条「真功夫」）
  真功夫: '/food/rice.jpg',
  吉野家: '/food/rice.jpg',
  喜茶: '/food/dessert.jpg',
  蜜雪: '/food/dessert.jpg',
  奈雪: '/food/dessert.jpg',
  茶百道: '/food/dessert.jpg',
  古茗: '/food/dessert.jpg',

  // 米饭类 / 其他
  米线: '/food/noodles.jpg',
  咖喱: '/food/rice.jpg',
  炒饭: '/food/rice.jpg',
  盖饭: '/food/rice.jpg',
}

/**
 * 根据食物名称查找对应的图片路径。
 * 1. 先精确匹配
 * 2. 再按关键词匹配（按关键词长度降序，优先匹配更具体的）
 * 没命中返回 null（调用方应回退到占位图）。
 */
export function resolveFoodImage(name) {
  if (!name) return null
  // 1. 精确匹配
  if (IMAGE_MAP[name]) return IMAGE_MAP[name]
  // 2. 关键词匹配
  const keys = Object.keys(IMAGE_MAP).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (name.includes(key)) return IMAGE_MAP[key]
  }
  return null
}
