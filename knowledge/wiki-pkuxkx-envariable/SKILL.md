---
name: wiki-pkuxkx-envariable
description: 环境变量（操作命令）
---
> 来源：https://www.pkuxkx.net/wiki/pkuxkx/envariable
> 抓取：2026-01-12（游戏版本可能已变化；实机行为为准，本文仅供参考）
简介

您可用 set 指令来设定一些有用的环境变量，这些变量也会随著您的人物被储存下来，如果有不需要的环境变量，也可以用 unset 删除。详细的使用方法请参考 help set 及 help unset。变量越来越多，输入set -q查询查询包含关键字的所有变量。

北大侠客行变量设定

变量ForcedAct            描述可设定武功招式不需要气势强发，强发后24秒不能涨气势，可设定值：1

变量damage_control       描述大宗师大宗师可以1-10000的范围控制伤害如果计算的伤害大于设定，则最多实际造成设定数值，低于则用计算伤害。控制伤害每次输出会有额外精力消耗。

变量CastNoSignature      描述锻造师铸造的物品不贴上签名，可设定值：1

变量ChatColor            描述使用个性化颜色聊天，可设定值：1

变量NoVeinOtherGift      描述通脉后不增长福源，灵性，容貌，可设定值：1

变量adv_quest            描述部分任务设定困难模式，可设定值：10-50

变量area_detail          描述可以方便区分城内和野外，可设定值：1

变量auto_reply           描述自动应答，可设定值：任意信息

变量bishen               描述设定在施展以彼之道还施彼身时是否反击，可设定值：off或on

变量block_bene_report    描述不显示学习加成报告，可设定值：1

变量brief                描述可设定值：0-3

变量brief_message        描述可设定值：1

变量broadcast_combat     描述广播战斗信息，可设定值：1

变量bxs_old_pattern      描述给出字符版百晓生，可设定值：1

变量combat_report        描述战斗一些额外信息的报告，可设定值：1

变量crit                 描述设定是否出现暴击，可设定值：off或on

变量custom_hp            描述自定hp数值显示，0显示以亿，万为单位，1显示数字，2用分隔符显示数字，可设定值：0-2

变量custom_sc            描述自定义score显示，可设定值参考help score

变量edu                  描述设定是否由8082端口发送图片，可设定值：1

变量food                 描述可食用房间食物，否则只食用身上的食物，可设定值：1

变量gangqi               描述先天罡气，可设定值：

变量hansz_new_mode       描述设定韩世忠任务均为图片显示迷宫路径模式，可设定值：1

变量hubiao_additional    描述护镖附加任务，可设定值：1

变量jianqi               描述设定太乙剑法剑气效果，可设定值：破或网

变量jindou               描述设定圣火令法筋斗效果，可设定值：1-4

变量jixue                描述血刀经祭血效果，可设定值：1-6

变量kill_msg             描述下kill命令时显示的信息，可设定值：任意信息

变量killall_msg          描述下killall命令时显示的信息，可设定值：任意信息

变量learn_emote          描述学习emote，设定后公共频道显示emote命令，可设定值：1

变量levelup              描述设定用修行经验升级，可设定值：deposit

变量localmap             描述设定1则瞬时显示全部地图信息，对于较大地图，可设0分页显示，可设定值：1或0

变量map_detail           描述设定之后可看到更详细的小地图，可设定值：1或0

变量mxp                  描述mxp扩展方式，客户端必须支持mxp，可设定值：1

变量mxp_image            描述在客户端看到图片，可设定值：1

变量mxp_sound            描述设定可从客户端接收声音，可设定值：1

变量mxp_user             描述mxp扩展方式看世界，客户端必须支持mxp，可设定值：1

变量newbiejob            描述华山派选择接受新手任务，而不是正常送信任务，可设定值：1

变量ningxue              描述凝血神爪效果，可设定值：1

变量no_accept            描述不接受任何物品，可设定值：1

变量no_autosave          描述禁止系统自动存盘，可设定值：1

变量no_story             描述不接受事件描述，可设定值：1

变量no_teach             描述不教学生任何东西，可设定值：1

变量no_transfer          描述不接受转账，可设定值：1

变量noreceivehelp        描述不接受新手帮助信息，可设定值：1

变量nowieldmsg           描述不显示wield装备的信息，可设定值：1

变量nowiki               描述设定后help将不从北侠wiki中搜索答案，可设定值：1

变量public               描述设定公开自己的email地址，可设定值：1

变量pyh                  描述鄱阳湖任务不出现随机里程，可设定值：piao

变量pyh_deposit          描述鄱阳湖任务部分经验奖励转为修行经验，可设定值：1

变量pyh_no_siling        描述鄱阳湖任务不出现四灵宝石奖励，可设定值：1

变量rbz_filter           描述荣宝斋sell all时候的filter，格式如下：hole:2|damage:200|armor:200|suit:1，意思是2孔或以上或伤害200或以上或防御200或以上或是套装不卖。四个变量可以随意组合，次序不重要。"｜"隔开不同类别，":"隔开 键和值。

变量refuse_firework      描述不观看任何烟火，可设定值：1

变量refuse_tell          描述不收听tell，1可收听好友列表，2完全不收听，可设定值：1,2

变量shenghuo             描述设定圣火令法圣火效果,可设定值：1

变量shenni               描述神尼任务自动变为最低一级，必须自己和队友都设定，可设定值：1

变量shiye                描述视野，101级以上，内力精纯度75%可用，可设定值：1

变量skip_combat          描述忽略战斗信息显示，可设定值：0-2

变量smithing             描述锻造师锻造时的目标，可设定值：任意信息

变量tianmo-jieti         描述设定发动天魔解体，可设定值：1

变量tutor_report         描述是否汇报自己养成东西（比如保镖）的情况，可设定值：1

变量vein                 描述设定通脉目标，参考help vein，可设定值：经脉名称

变量vigour_vein          描述使用真气而不是内力来通脉，可设定值：1

变量wimpy                描述气血低于多少百分比时尝试逃跑，可设定值：0-100

变量xx_poison            描述星宿毒掌效果，可设定值：正常、内敛或散毒

变量yiyang               描述一阳指出全真效果或天龙效果，可设定值：quanzhen或tianlong

部分环境变量

brief

<任意非零值>

设定移动时只看所在地简短的名称，如果您觉得网络速度太慢，或者是对区域已经十分熟悉，您可以考虑采用 brief 模式以减轻网络负担。

set brief 1，显示即时地图、出口和物品。

set brief 2，会显示出口及物品。

set brief 3，会显示物品。

custom_hp

<任意非零值>

自定义 hp 命令显示数值的方式

set custom_hp 1，【 经验 】 3208633

set custom_hp 2，【 经验 】 3,208,633

set custom_hp 3，【 经验 】 320.86万

nowieldmsg

设置不接收其他玩家或者npc使用wield,unwield,wear,remove命令时的信息。

skip_combat

<任意非零值>

省略战斗信息。 屏蔽战斗信息，有四类，分别是1，2，3和4。

set skip_combat 1 屏蔽普通招式的信息。

set skip_combat 2 在1的基础上是屏蔽回合和互搏提示信息。

set skip_combat 3 屏蔽除受伤外的所有信息。

set skip_combat 4 是屏蔽所有信息。

上述设置都不屏蔽perform信息。

broadcast_combat

<任意非零值>

接收他人的战斗信息，接收信息级别由skip_combat环境变量决定。perform产生的战斗信息和本环境变量无关。

refuse_tell

<任意非零值>

设定拒绝别人对你的谈话。

no_teach

<任意非零值>

设定您现在不教您的徒弟技能，由於教徒要是要费精神，当徒弟不乖时…。

no_accept

<任意非零值>

设定您现在不接受别人 give 的物品。

wimpy

<百分比>

当您的「精」或「气」低於这个百分比时就会自动找机会逃命。

learn_emote

1

会显示闲聊频道中别人动作的emote。

public

1

公开你注册的email地址，让别人更方便地联系你。

answer_<问话>

<回答>

别人问你关于<问话>的时候，即ask  about <问话>时自动回答<回答>设定的内容。可以用$N代表自己，$n代表问你话的人。

kill_msg

<字符串>

设定对别人下kill指令时你说的话。可以用$N代表自己，$n代表你要杀的人，$R，$r，$S，$s分别代表自己和对方的（粗鲁）称呼。

killall_msg

<字符串>

设定下killall指令时显示的内容。系统会自动用你的名字、感叹号和换行符补全。

no_autosave

<任意非零值>

避免系统自动定时为你保存档案。

xx_poison

<字符串>

设定星宿毒掌普通攻击：

散毒 ：随机出自动perform。

内敛 ：普通攻击不带毒。

正常 ：普通攻击带毒。

ningxue

<任意非零值>

设置云龙爪特殊攻击凝血神爪主动抓人，如果无参数则优先抓兵器，没兵器则抓人。

jile npc

星宿派极乐刺不攻击玩家，否则攻击同房间所有人。

no_ip

<任意非零值>

设置在who -i查询与使用者同地区的玩家时不列出自己。

msgfilter[1-5]

<需要过滤的特定字符>

支持*作为通配符。

例如set msgfilter1 *深深吸了一口气

food

可以饮用或食用所在房间的物品，不设置时只能饮用或食用自己身上的物品。

pyh_deposit

鄱阳湖寻宝任务奖励把1/10存起来。

pyh_no_siling

鄱阳湖寻宝任务用1/10经验奖励换取不出四灵类宝石。

pyh piao

鄱阳湖寻宝不遇到钓鱼人传音，即不出现随机里程。

bxs_old_pattern yes

用老版字符验证，不设置就是图片验证。

hubiao_additional

护镖在固定轮次出现附加任务。

no_listen_npc

<任意非零值>

过滤部分npc在公共频道的发言。

custom_sc

<字符串>

自定义 sc 命令的显示内容

-T 头衔

-A 年龄

-G 天赋属性

-F 门派

-D 死亡记录

-S 杀气

-B 银行存款

-L 等级

-E 经验

-SH 道德和潜能

-LO 门忠和声望

可以组合使用，比如 set custom_sc -T-A-G-F

set

-qq  查询任务相关变量 query quests

-qm 查询杂项变量 query miscellany

qf 查询战斗和技能相关变量 query fights

player_define、player_define2、player_define3….player_define5 玩家自定义变量

set命令完善查询功能，by zine

jobquery加入新任务，支持自定义，by zine
