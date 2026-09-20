"""Read a bounded, local XLSX copy table. Never evaluate formulas or links."""
import json
import sys
import zipfile
import posixpath
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

def read_table(filename, accounts=False):
    with zipfile.ZipFile(filename) as z:
        infos = z.infolist()
        if len(infos) > 2000 or sum(i.file_size for i in infos) > 32_000_000:
            raise ValueError('Excel 文件过大')
        def xml(name):
            data = z.read(name)
            if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                raise ValueError('不支持 XML 实体')
            return ET.fromstring(data)
        sheets = xml('xl/workbook.xml').findall('s:sheets/s:sheet', NS)
        sheet_name = '账号库' if accounts else '测试文案'
        columns = ('A', 'B', 'C', 'D', 'E', 'F') if accounts else ('A', 'B', 'C')
        selected = next((s for s in sheets if s.get('name') == sheet_name), None)
        if selected is None:
            if len(sheets) != 1:
                raise ValueError('请保留一个工作表，或命名为 ' + sheet_name)
            selected = sheets[0]
        relationships = xml('xl/_rels/workbook.xml.rels')
        rel = next(r for r in relationships if r.get('Id') == selected.get(REL))
        if rel.get('TargetMode') == 'External':
            raise ValueError('不支持外部工作表')
        target = rel.get('Target', '')
        target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if not target.startswith('xl/'):
            raise ValueError('工作表路径无效')
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(si.itertext()) for si in xml('xl/sharedStrings.xml')]
        rows = []
        for row in xml(target).findall('s:sheetData/s:row', NS):
            if len(rows) >= 10001:
                raise ValueError('文案最多10000条')
            values = {}
            for cell in row.findall('s:c', NS):
                column = ''.join(c for c in cell.get('r', '') if c.isalpha())
                if column not in columns:
                    continue
                if cell.find('s:f', NS) is not None:
                    raise ValueError('文案表只接受纯文本，不支持公式')
                value = cell.findtext('s:v', '', NS)
                kind = cell.get('t')
                if accounts and column == 'A' and rows and value and kind not in ('s', 'inlineStr', 'str'):
                    raise ValueError('抖音号必须设为文本格式后重新输入，避免数字精度或前导零丢失')
                if kind == 's':
                    value = strings[int(value)]
                elif kind == 'inlineStr':
                    value = ''.join(cell.find('s:is', NS).itertext())
                elif kind == 'e':
                    raise ValueError('Excel 单元格含错误')
                values[column] = value
            rows.append([values.get(c, '') for c in columns])
        return rows

try:
    print(json.dumps(read_table(sys.argv[1], len(sys.argv) > 2 and sys.argv[2] == 'accounts'), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
