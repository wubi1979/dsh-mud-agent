---
name: wiki-pkuxkx-command
description: 命令一览（操作命令）
---
> 来源：https://www.pkuxkx.net/wiki/pkuxkx/command
> 抓取：2026-01-12（游戏版本可能已变化；实机行为为准，本文仅供参考）
命令一览

以下命令中的“|”表示可以互相替换的缩写、全称、拼音命令或者英语命令。

人物（动物）交互命令

kill 人物id

主动攻击，试图杀死对方（俗称叫杀）。对方也同样会试图杀死你。请谨慎使用。

killall

主动攻击，试图杀死同一房间内的所有npc。对方也同样会试图杀死你。请谨慎使用。

killall 人物id

主动攻击，试图杀死同一房间内的所有叫这个id的npc。对方也同样会试图杀死你。请谨慎使用。

注意，有几个地方，初期是不能轻易下kill和killall的，会被NPC杀死：

扬州飞龙帮、泉州巨鲸帮、泰山封禅台、泰山正气厅、泰山侠义厅这些地方不能下kill只能killall加id否者这里的玩家NPC会对你叫杀，

另外康亲王府书房不能随便进去一进去就会被通缉，被通缉后不能随便进北京皇宫和北京城，遇到巡逻的会跟随你叫杀这里你没有300M以上一群大内侍卫高手会围死你，

最后告诫大家江南建康府的看门的那些武将官兵是绝对不要下kill和killall,杀一个会被全服的官兵追杀不管路过哪个城门都是满屏红色叫杀还不能被疏通需要等一个小时以上quit都没用。

hit 人物id

强迫对方与你战斗，可以一直hit直到对方昏迷。

（相当于另一种形式的kill，优点是有机率不被叫杀。）

hitall

强迫同一房间内的所有npc与你战斗。

hitall 人物id

强迫同一房间内的所有叫这个id的npc与你战斗。

fight 人物id

要求别人与你进行战斗，点到为止。

give 人物id 物品id|give 物品id to 人物id

给别人物品。

get all from corpse

搜查尸体。

ask 人物id about 任何事情

向别人打探某件事情，这个命令在解谜时很重要，通常需要ask才能获得进一步的信息。

ask 人物id about all

向别人打探，他都知道什么事情。

成年后1次花费1金。

train 动物id

训练动物，坐骑。

eat 食物id

吃东西，吃东西加人物状态食物一项，这项为零不自动恢复精神气血，eat参数-stat，可以查询本次重启之后吃掉、喝掉的食物饮水

drink 装水器皿id

喝水，喝水加任务状态饮水一项，这项为零同样不自动恢复精神气血，并且在大沙漠还容易晕倒。

场景交互命令

方向

移动到某个方向。

go 方向

移动到某个方向。

open 场景物品id

开。（并不太统一，比如，开门可能是open men，也可能是open door）

close 场景物品id

关。

climb 场景物品id

攀爬，如新手教程中的爬过小缓坡就是 climb path

localmaps（快捷指令 lm）

查看本地地图。

localmaps 房间名称

查看本地地图，高亮显示该房间。

maphere

查看附近地图。

comment

一切皆可评论命令，comment here|物品|npc名查看其他玩家已经添加的评论

comment -a here|物品|npc 加入你的评论

回复已有某条评论在内容部分后面加 @

物品交互命令

get 物品id

捡起物品。

get all

捡起所有物品。

drop 物品id

丢弃物品。

drop all

丢弃所有物品。

wear 衣服等id

穿上。支持特定中文名称，特定名称和mine都支持强制替换已有部位支持强制替换已有部位。

wear all

wear mine

穿上所有autoload的装备，如果遇到已有部位已经装备则自动替换成autoload的装备。

remove 衣服等id

脱下。

remove all

wield 武器id

装备武器。可以使用wield at left/right 选择装备在哪只手

unwield 武器id

放下手里的武器。

addvalue

北侠车船通充值。

ride

一些场景中可用过划船。

获取信息命令

命令模糊查询

如果你想不起来完整命令，可以通过部分字母加问号来查询命令。

as?

符合你查找的命令有：ask、pass、alias、disassemble、passwd、task。

l|look

显示所处地点的详细信息。

l|look 方向

显示所处地点该方向前方地点的详细信息。

l|look 人物id

显示所处地点该人物的详细信息。

lookin 人物id

显示所处地点该人物的真面目。

l|look 物品id

显示身上，或所处地点该物品的详细信息。

sc|score

显示个人档案。

status_me

显示自己的各项战斗属性。

有命令参数： -a/-b/-c

hp

显示自己的精神，气血等信息。

hpbrief

显示自己的精神，气血等信息。

推荐设置变量：set hpbrief long,report

以获得更多状态，和在战斗中自动获取状态。

格式：

#经验,潜能,最大内力,内力,最大精力,精力

#气血上限,最大气血,气血,精神上限,最大精神,精神

#真气,战意,食物,饮水,非战斗/战斗中,不忙/忙

i|inventory

查询自己身上的物品

id

显示自己身上的物品id，有些id相同的物品不进行合并，会依次列出。格式如下：

你身上携带物品的别称如下 :

干粮                           = gan liang, ganliang, liang

铜板                           = coin, coins, coin_money

白银                           = silver, ingot, silver_money

武士刀                         = wushi dao, dao

牛皮酒袋                       = jiudai, wineskin, skin

武士刀                         = wushi dao, dao

牛皮酒袋                       = jiudai, wineskin, skin

牛皮酒袋                       = jiudai, wineskin, skin

锦囊                           = jin nang, nang, baoshi dai, dai, gem bag, sachet

i2

另外一种形式显示自己身上的物品id，相同id的物品会合并到一组，在前面标注数量。格式如下：

你身上带著下列这些东西(负重 35%)：

一百七十四块干粮(Gan liang)

八十文铜板(Coin)

十两白银(Silver)

二柄武士刀(Wushi dao)

三个牛皮酒袋(Jiudai)

锦囊(Jin nang)

-------------------------------------------

你右手拿着：武士刀(Wushi dao)

-------------------------------------------

你身上穿着：

锦囊(Jin nang)

id here

显示所有跟你在同一个房间里的人物及物品id。格式如下：

在这个房间中, 生物及物品的(英文)名称如下 :

牛皮酒袋                       = jiudai, wineskin, skin

陆乘风                         = lu chengfeng, lu, chengfeng

归云庄卫士                     = wei shi, shi, wei

who

显示在线玩家名单。

有命令参数： -l/-w

news

看看有什么新闻。

time

查询现实和mud时间。

exp

查看连线时间和经验值统计信息。

mudage

显示自己在mud中度过的时间。

uptime

北大侠客行已经执行的时间。

wizlist

列出巫师名单。

paihang

高手排行榜。

top

高手爬行榜。

武功相关命令

作为武侠游戏最重要的内容，特将武功相关命令集中归类。

sk|skills|cha

显示自己所学过的技能。

sk|skills|cha 人物id

显示师徒、或夫妻所学过的技能。

sk|skills|cha -learn 人物id

显示师傅可以被学习的武功级别。（限部分npc）

skbrief 武功id

显示自己某技能的具体信息。

格式：

#技能等级/技能小点

verify 武功id

显示某种武功的功能及特殊招式。

激发：jifa|enable

显示你掌握的基本武功，每种基本武功激发的特殊武功，特殊武功的有效等级。

jifa|enable ?

列出所有能使用特殊技能的技能种类。

jifa|enable 基本武功id 特殊武功id

指定所要用的特殊技能，需指明技能种类和技能名称。

备：bei|prepare 特殊武功id

一般角色都会不止一种空手武功，激发以后还需要备一下，才能将选定的特殊武功在战斗中使用出来。

互备（空手） bei|prepare 特殊武功id 特殊武功id

有些空手武功可以组合使用，攻击速度+0.5，不能和互博（攻击速度+1）叠加。

互备（武器） wbei 特殊武功id 特殊武功id

有些武器武功也可以组合使用，攻击速度+0.5，不能和互博（攻击速度+1）叠加。

拜师：bai|apprentice 人物id

拜某人为师。

读书：du|study 书籍id 次数

通过读书提高某种技能，必须会读书识字。

学习：xue|learn 人物id for 武功id 次数

向别人请教有关某一种技能的疑难问题，你请教的对象在这项技能上的造诣必须比你高，而你经由这种方式学习得来的技能也不可能高於你所请教的人，请教需要消耗自己的潜能。此外学习也需要消耗一些精力，而消耗的精力跟你自己、与你学习对象的悟性有关。当你要学习的功夫等级已经高于你的师父时，再学就是以切磋的形式来学了。这时消耗的潜能、精力都是正常学习时的好几倍。除非没有更厉害的师父可以拜了，否则还是尽量拜更高级师父以保证正常的学习速度。

修炼：xiulian 特殊内功id

修炼内功是后期提高特殊内功的唯一途径，修炼有可能走火，所以最好在安全的地方修炼以避免走火。

练习：lian|pratice 基本武功id 次数

练习某个种类的技能，这个技能必须是经过 jifa 的特殊技能。如果你对这方面的基本技能够高，可以经由练习直接升级，而且升级的上限不能超过你的基本技能的等级。

领悟：lingwu 基本武功id 次数

如：lingwu force 10

新增了剑心居机制，建议去剑心居领悟。

各门派领悟地点：

武当派：静修阁

华山派：练功房

明教：练功房

全真派：静思院

天龙寺：后院

桃花岛：归云庄练功房

少林寺：达摩院二楼

古墓：演武洞

丐帮：土地庙

峨嵋派：神灯阁二楼

日月神教：望海石

星宿派：后山石壁

慕容：燕子坞花园

大轮寺：苦修札仓

朝廷：校场

灵鹫宫：戏凤阁

白驼山：练功室

雪山派：静修室

天地会：侧厅

神龙教：练功房

青城派：闭关密室

百姓：武馆练功场

打坐：dazuo|exercise 数值|max

将你的气血转化为内力。当内力超过自己内力上限的两倍，内力上限又没达到内功支持的内力极限时，内力上限就会增长一点。

打坐：dz

缓慢增加内力和提高基本内功。内功到达一定水平后dz有可能会打通任督二脉，所有先天随机增加1－2点。

在dz时halt或者战斗等可能导致走火，减少内力上限。所以最好在安全的地方dz以避免走火。

转换：transform 来源特殊内功id into 目标特殊内功id|none 转换百分比

将不同内功的内力相互转换。

吐纳：tuna|respirate 数值|max

将你的精神转变成精力。当精力超过自己精力上限的两倍，精力上限又没达到内功支持的精力极限时，精力上限就会增长一点。

加力：jiali|enforce 数值|none|half|max

每次击中敌人时，发出几点内力伤敌。

内功功能：yun|exert 功能名称 (施用对象)

使用内功功能，必须jifa指定你要使用的内功。

内功的普通功能：

recover            恢复自己的气血。

qi                 持续恢复自己的气血。

regenerate         恢复自己的精神。

jing               持续恢复自己的精神。

内功的特殊功能（可能有些内功没有）：

heal               用内力替自己疗伤（回复有效气血）。

lifeheal           用内力替他人疗伤。

inspire            用内力回复有效精神。

powerup            用内力短时间内将自己的战斗力提高。

roar               用内力发出吼声，震昏同一房间的其他生物。

外功绝招：perform (武功种类.)招式名称 (施用对象)

使用外功绝招，必须jifa指定你要使用的武功，不指定武功种类时，空手的外功是指你的拳脚功夫，使用武器时则是兵刃的武功。

如：太极剑法之缠字决可以用 perform taiji-jian.chan 或者直接 perform chan

abandon|fangqi 技能名称

放弃一项你所学过的技能，注意这里所说的「放弃」是指将这项技能从你人物的资料中删除。

part_abandon <技能名称> <放弃的级别数>

放弃自己某种技能若干级。可以在需要调整自己的技能等级时使用。

整理中

setfrd 设定好友名单

unsetfrd 取消好友设定

jiaoliang 玩家和玩家之间或者玩家和npc之间用jiaoliang命令战斗，不会造成实质伤害。

交流

tell <sb> <信息>          告诉玩家一些信息，只有你们两人能看到

reply <信息>              回答刚才tell你的人

say <信息>                说话，同一房间的人都可听到

whisper <sb>              对同一房间的人说悄悄话

loving                    夫妻间亲热的指令

emote                     做一个系统没有定义的动作

femote 查询emote

whistle 吹口哨。。

maimai 你一边在自己头上插根草标一边大声喝道：「谁要买我？」，哼！一副穷酸样。

宠物相关

slaughter 杀死自己的宠物

外部

quit 退出mud，回到现实世界

save 保存自己的状态

version 显示mudos版本

auto_reply                设定自动回复信息

changewield               交换左右两手的武器

beg <sth> from <sb>       向某人乞讨，丐帮弟子才能使用

check <sb>                打听别人技能，丐帮弟子才能使用

follow <sb>               跟随别人一起行动

guard <方向> ；guard <sb> ；guard <sth>  守卫某个方向，物品或人物

halt                      强行中止正在进行的动作

put <sth> in <容器>       把物品放到某容器内

semote                    列出所有可以使用的emote

shichou <sb>              若你与别的玩家结仇，见面会自动kill，用此命令解除结仇状态

sleep                     睡觉，是快速恢复精神和体力的方法。

steal <sth> from <sb>     偷窃别人的东西

team <sb>                 组织队伍

vote                      提议对某人采取行动，由大家投票决定。如果五分钟内没有人附议，

投票会自动取消。当前可以有如下<动议>：

chblk: 关闭某人交谈频道，需三票以上的简单多数同意。

unchblk: 打开某人交谈频道，需三票以上的三分之一票数同意。

alert 朝廷官员召唤高手保护自己的命令

alias 设定一些命令替代系统提供的命令，可用$1 $2 $3 等参数，to alias多行命令

–cemote（目前关闭） 模拟系统的emote做一个动作

describe 设定别人look自己时的描述

destroy 销毁礼品

do<次数> <命令> 将命令重复10次以内

femote <pattern> 查找含有<pattern>字样的emote

finger 查询玩家连线资料等信息

help <主题> 寻求关于某一<主题>帮助

locate <task物品名> 查找task物品的位置

nick 给自己取个响亮的外号

paimai 拍卖物品

passwd 修改自己的mud密码

set 设定一些环境变量的值

setmail 申请@pkuxkx.net邮箱

sos 向巫师求救

suicide -f 再也不玩了，自杀吧。没有后悔药的，考虑清楚了

task 显示task任务榜

title 看自己的头衔和外号等

to 发送多行信息，如to chat；to rumor

tune；tune channel <channelid> 关闭自己的某个频道，无参数则显示现在收听的频道

unset 取消某个环境变量的设定

votehelpnew 新手投票

whistle 召唤自己的宠物

wimpy 显示自己的wimpy参数设置

showequip 向大家展示自己装备的属性

jobquery 这个指令可以显示你当前的任务状态，包括门忠任务，满不懂任务等等。

自定义jobquery -m 显示门派任务 -x 新手任务 -z 主流任务 -t 特殊任务，

jobquery ++ 加入自定义任务列表，比如jobquery ++1 把1号任务加入列表。 --从自定义列表中删除。

符合你查找的命令有：duanjin、dunji、jianxiao、jinglei、pojia、xiejia。（这么一想。。想要称上命令一览。。要加的职业命令有得是啊。。

？？？

accept <sb> 收某人为弟子, 如果对方也答应要拜你为师的话

expell | kaichu 开除不成才的弟子，被开除的弟子所有技能都会降到原来的一半

recruit | shou [cancel] | <对象>  收某人为弟子，如果对方也答应要拜你为师的话

hatred 查询你的师门和别的门派间的关系程度

createskill

selfpractice

selfthinking

jingji*

cemote

editedmote

enchance

estell

hatred

skill

scan

baishi

nuoyi

research

quanjia

music

mudlist 网路精灵并没有被载入，请先将网路精灵载入。

pr

sms（目前关闭）利用移动飞信给自己的手机发短信

webuser

zmuduser

locate

job  获取任务 ask *** about job

note 笔记 记录洗澡，吃药，升级等获得天赋，help note 查详细信息。
