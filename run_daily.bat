@echo off
rem 每日自动运行: 市场宽广度(红盘率 + 阿姆氏指标)构建 (任务计划程序 交易日 16:10 调用)
cd /d "%~dp0"
echo [%date% %time%] 开始运行 >> run_daily.log
python build_breadth.py >> run_daily.log 2>&1
echo [%date% %time%] 运行结束 (exit=%errorlevel%) >> run_daily.log