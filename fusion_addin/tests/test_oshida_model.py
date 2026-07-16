import json
import math
import sys
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ADDIN_ROOT = REPOSITORY_ROOT / 'fusion_addin' / 'OshidaSmartphoneCadImporter'
sys.path.insert(0, str(ADDIN_ROOT))

from oshida_model import (  # noqa: E402
    get_document_dimensions,
    get_shape_bounds,
    get_shape_profiles,
    is_full_face_rectangle,
    normalize_document,
)


class OshidaModelTest(unittest.TestCase):
    def load_example(self, name):
        path = REPOSITORY_ROOT / 'examples' / name
        return normalize_document(json.loads(path.read_text(encoding='utf-8')))

    def assert_closed_profile_has_no_zero_segments(self, profile):
        if profile['kind'] != 'polyline':
            return
        points = profile['points']
        self.assertGreaterEqual(len(points), 3)
        distances = [
            math.dist(points[index], points[(index + 1) % len(points)])
            for index in range(len(points))
        ]
        self.assertGreater(min(distances), 0.000001)

    def test_all_repository_examples_are_supported(self):
        shape_types = set()
        for path in sorted((REPOSITORY_ROOT / 'examples').glob('*.json')):
            document = normalize_document(json.loads(path.read_text(encoding='utf-8')))
            get_document_dimensions(document)
            for shape in document['shapes']:
                shape_types.add(shape['type'])
                profiles = get_shape_profiles(shape)
                self.assert_closed_profile_has_no_zero_segments(profiles['outer'])
                for hole in profiles['holes']:
                    self.assert_closed_profile_has_no_zero_segments(hole)
        self.assertEqual(shape_types, {'rect', 'circle', 'gear', 'rack', 'internalGear'})

    def test_spur_gear_preserves_outer_diameter_and_bore(self):
        shape = self.load_example('spur-gear.json')['shapes'][0]
        bounds = get_shape_bounds(shape)
        profiles = get_shape_profiles(shape)
        self.assertAlmostEqual(bounds['maxX'] - bounds['minX'], 26, places=6)
        self.assertEqual(profiles['outer']['kind'], 'polyline')
        self.assertEqual(profiles['holes'][0]['kind'], 'circle')
        self.assertAlmostEqual(profiles['holes'][0]['radius'], 3)

    def test_rack_rotation_changes_the_bounding_axes(self):
        shape = self.load_example('rack-gear.json')['shapes'][0]
        rotated = dict(shape, rotation=90)
        original_bounds = get_shape_bounds(shape)
        rotated_bounds = get_shape_bounds(rotated)
        self.assertAlmostEqual(original_bounds['maxX'] - original_bounds['minX'], 62.8, places=6)
        self.assertAlmostEqual(rotated_bounds['maxY'] - rotated_bounds['minY'], 62.8, places=6)
        self.assertAlmostEqual(rotated_bounds['maxX'] - rotated_bounds['minX'], 10, places=6)

    def test_internal_gear_is_an_outer_circle_with_a_tooth_hole(self):
        document = self.load_example('internal-gear.json')
        shape = document['shapes'][0]
        profiles = get_shape_profiles(shape)
        self.assertEqual(profiles['outer']['kind'], 'circle')
        self.assertAlmostEqual(profiles['outer']['radius'], 34)
        self.assertEqual(len(profiles['holes']), 1)
        self.assertEqual(profiles['holes'][0]['kind'], 'polyline')
        self.assertFalse(is_full_face_rectangle(document, 'top'))
        self.assertTrue(is_full_face_rectangle(document, 'front'))
        self.assertTrue(is_full_face_rectangle(document, 'right'))

    def test_face_with_a_cut_is_not_a_redundant_rectangle(self):
        document = self.load_example('three-face-bracket.json')
        self.assertFalse(is_full_face_rectangle(document, 'top'))
        self.assertFalse(is_full_face_rectangle(document, 'front'))
        self.assertTrue(is_full_face_rectangle(document, 'right'))

    def test_unknown_shape_is_rejected_instead_of_silently_removed(self):
        document = {
            'schemaVersion': 5,
            'activeFace': 'top',
            'shapes': [{'id': 1, 'type': 'triangle', 'x': 0, 'y': 0, 'mode': 'add', 'face': 'top'}],
        }
        with self.assertRaisesRegex(ValueError, 'Unsupported shape type'):
            normalize_document(document)

    def test_future_schema_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported schemaVersion'):
            normalize_document({'schemaVersion': 99, 'shapes': []})

    def test_non_integer_tooth_count_is_rejected(self):
        document = json.loads((REPOSITORY_ROOT / 'examples' / 'spur-gear.json').read_text(encoding='utf-8'))
        document['shapes'][0]['teeth'] = 24.5
        with self.assertRaisesRegex(ValueError, 'must be an integer'):
            normalize_document(document)


if __name__ == '__main__':
    unittest.main()
