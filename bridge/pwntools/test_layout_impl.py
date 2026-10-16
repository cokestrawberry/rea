"""Source-owned tests for the pwntools layout adapter's dynamic dependency names."""

import importlib.util
import os
import types
import unittest


spec = importlib.util.spec_from_file_location(
    "rea_pwntools_layout_impl", os.path.join(os.path.dirname(__file__), "layout_impl.py")
)
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

TABLE = b"\0libc.so.6\0libm.so.6\0"
TABLE_FILE_OFFSET = 0x100
TABLE_ADDRESS = 0x4000
CONTENT = bytes(TABLE_FILE_OFFSET) + TABLE


class Tag:
    def __init__(self, d_tag, d_val, reads):
        self._d_tag = d_tag
        self.d_val = d_val
        self._reads = reads

    @property
    def d_tag(self):
        self._reads[0] += 1
        return self._d_tag


class Image:
    def __init__(self, segments):
        self.segments = segments
        self.scans = 0

    def iter_segments_by_type(self, segment_type):
        assert segment_type == "PT_LOAD"
        self.scans += 1
        return iter(self.segments)


def load_segment(address, file_offset, file_size):
    return types.SimpleNamespace(
        header=types.SimpleNamespace(p_vaddr=address, p_offset=file_offset, p_filesz=file_size)
    )


def table_tags(reads, needed, strtab=(TABLE_ADDRESS,), strsz=(len(TABLE),)):
    tags = [Tag("DT_NEEDED", offset, reads) for offset in needed]
    tags += [Tag("DT_STRTAB", value, reads) for value in strtab]
    tags += [Tag("DT_STRSZ", value, reads) for value in strsz]
    return tags + [Tag("DT_NULL", 0, reads)]


def mapped_image():
    return Image([load_segment(TABLE_ADDRESS, TABLE_FILE_OFFSET, len(TABLE))])


class DynamicNameReferenceTests(unittest.TestCase):
    def test_names_keep_tag_order_with_raw_bytes_and_file_ranges(self):
        tags = table_tags([0], [11, 1])
        references = layout.dynamic_name_references(tags, mapped_image(), CONTENT)
        self.assertEqual([reference["display"] for reference in references], ["libm.so.6", "libc.so.6"])
        self.assertEqual(references[1]["location"], {"offset": hex(TABLE_FILE_OFFSET + 1), "bytes": hex(10)})
        self.assertEqual(references[1]["bytes_base64"], "bGliYy5zby42")

    def test_table_mapping_and_tag_scan_do_not_repeat_per_dependency(self):
        reads = [0]
        tags = table_tags(reads, [1] * 2000)
        image = mapped_image()
        references = layout.dynamic_name_references(tags, image, CONTENT)
        self.assertEqual(len(references), 2000)
        self.assertEqual(image.scans, 1)
        self.assertLessEqual(reads[0], 3 * len(tags))

    def test_dependency_free_dynamic_segment_needs_no_string_table(self):
        tags = [Tag("DT_NULL", 0, [0])]
        self.assertEqual(layout.dynamic_name_references(tags, Image([]), CONTENT), [])

    def test_missing_string_table_tags_are_format_failures(self):
        for strtab, strsz in [((), (len(TABLE),)), ((TABLE_ADDRESS,), ())]:
            with self.subTest(strtab=strtab, strsz=strsz):
                tags = table_tags([0], [1], strtab, strsz)
                with self.assertRaises(layout.LayoutFailure) as raised:
                    layout.dynamic_name_references(tags, mapped_image(), CONTENT)
                self.assertEqual(raised.exception.reason, "format")

    def test_duplicate_string_table_tags_are_unsupported_targets(self):
        tags = table_tags([0], [1], strtab=(TABLE_ADDRESS, TABLE_ADDRESS))
        with self.assertRaises(layout.LayoutFailure) as raised:
            layout.dynamic_name_references(tags, mapped_image(), CONTENT)
        self.assertEqual(raised.exception.reason, "unsupported-target")

    def test_unmapped_or_ambiguously_mapped_table_is_unsupported_target(self):
        for segments in [
            [],
            [
                load_segment(TABLE_ADDRESS, TABLE_FILE_OFFSET, len(TABLE)),
                load_segment(TABLE_ADDRESS, TABLE_FILE_OFFSET + 1, len(TABLE)),
            ],
        ]:
            with self.subTest(segments=len(segments)):
                with self.assertRaises(layout.LayoutFailure) as raised:
                    layout.dynamic_name_references(table_tags([0], [1]), Image(segments), CONTENT)
                self.assertEqual(raised.exception.reason, "unsupported-target")

    def test_name_offset_beyond_declared_size_fails_before_mapping_is_resolved(self):
        image = Image([])
        with self.assertRaises(layout.LayoutFailure) as raised:
            layout.dynamic_name_references(table_tags([0], [len(TABLE)]), image, CONTENT)
        self.assertEqual(raised.exception.reason, "format")
        self.assertEqual(image.scans, 0)


if __name__ == "__main__":
    unittest.main()
