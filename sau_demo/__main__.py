import sys
from .cli import main

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        print('已中断；正在提交的记录保持待核实，请先查看台账和平台。', file=sys.stderr)
        raise SystemExit(130)
