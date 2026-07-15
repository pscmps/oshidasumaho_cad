import math


MODEL_SCHEMA_VERSION = 5
FACE_ORDER = ('top', 'front', 'right')
FACE_AXES = {
    'top': {'x': 'width', 'y': 'depth'},
    'front': {'x': 'width', 'y': 'height'},
    'right': {'x': 'depth', 'y': 'height'},
}
SUPPORTED_SHAPE_TYPES = ('rect', 'circle', 'gear', 'rack', 'internalGear')
EPSILON_MM = 0.001
GEAR_MODULE_MIN = 0.5
GEAR_MODULE_MAX = 5.0
GEAR_PRESSURE_ANGLE_DEG = 20.0
GEAR_TEETH_MIN = 8
GEAR_TEETH_MAX = 80
RACK_TEETH_MIN = 1
RACK_TEETH_MAX = 80
INTERNAL_GEAR_TEETH_MIN = 34
INTERNAL_GEAR_TEETH_MAX = 120


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def round_model(value):
    return math.floor(float(value) * 10.0 + 0.5) / 10.0


def require_number(value, path, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('{} must be a finite number.'.format(path))
    if positive and value <= 0:
        raise ValueError('{} must be greater than zero.'.format(path))
    return float(value)


def require_integer(value, path, minimum, maximum):
    number = require_number(value, path, True)
    if not number.is_integer() or not minimum <= number <= maximum:
        raise ValueError('{} must be an integer between {} and {}.'.format(path, minimum, maximum))
    return int(number)


def normalize_face(face):
    if face == 'left':
        return 'front'
    if face not in FACE_ORDER:
        raise ValueError('Unsupported face: {}'.format(face))
    return face


def normalize_constraint(constraint):
    if not constraint:
        return None
    return {
        'minX': float(constraint.get('minX', 0)),
        'maxX': float(constraint.get('maxX', 120)),
        'minY': float(constraint.get('minY', 0)),
        'maxY': float(constraint.get('maxY', 120)),
        'constrainedX': bool(constraint.get('constrainedX')),
        'constrainedY': bool(constraint.get('constrainedY')),
    }


def normalize_shape(shape, index, default_face):
    if not isinstance(shape, dict):
        raise ValueError('shapes[{}] must be an object.'.format(index))
    shape_type = shape.get('type')
    if shape_type not in SUPPORTED_SHAPE_TYPES:
        raise ValueError('Unsupported shape type at shapes[{}]: {}'.format(index, shape_type))
    normalized = dict(shape)
    normalized['face'] = normalize_face(shape.get('face', default_face))
    normalized['mode'] = 'cut' if shape.get('mode') == 'cut' else 'add'
    normalized['x'] = require_number(shape.get('x'), 'shapes[{}].x'.format(index))
    normalized['y'] = require_number(shape.get('y'), 'shapes[{}].y'.format(index))

    if shape_type == 'rect':
        normalized['w'] = require_number(shape.get('w'), 'shapes[{}].w'.format(index), True)
        normalized['h'] = require_number(shape.get('h'), 'shapes[{}].h'.format(index), True)
    elif shape_type == 'circle':
        normalized['r'] = require_number(shape.get('r'), 'shapes[{}].r'.format(index), True)
    elif shape_type == 'gear':
        normalized['module'] = require_number(shape.get('module'), 'shapes[{}].module'.format(index), True)
        normalized['teeth'] = require_integer(
            shape.get('teeth'),
            'shapes[{}].teeth'.format(index),
            GEAR_TEETH_MIN,
            GEAR_TEETH_MAX,
        )
        normalized['bore'] = require_number(shape.get('bore', 0), 'shapes[{}].bore'.format(index))
        if normalized['mode'] != 'add':
            raise ValueError('gear only supports add mode.')
    elif shape_type == 'rack':
        normalized['module'] = require_number(shape.get('module'), 'shapes[{}].module'.format(index), True)
        normalized['teeth'] = require_integer(
            shape.get('teeth'),
            'shapes[{}].teeth'.format(index),
            RACK_TEETH_MIN,
            RACK_TEETH_MAX,
        )
        normalized['width'] = require_number(shape.get('width'), 'shapes[{}].width'.format(index), True)
        normalized['height'] = require_number(shape.get('height'), 'shapes[{}].height'.format(index), True)
        normalized['rotation'] = int(require_number(shape.get('rotation', 0), 'shapes[{}].rotation'.format(index))) % 360
        if normalized['mode'] != 'add':
            raise ValueError('rack only supports add mode.')
        if normalized['rotation'] not in (0, 90, 180, 270):
            raise ValueError('rack rotation must be 0, 90, 180, or 270.')
    else:
        normalized['module'] = require_number(shape.get('module'), 'shapes[{}].module'.format(index), True)
        normalized['teeth'] = require_integer(
            shape.get('teeth'),
            'shapes[{}].teeth'.format(index),
            INTERNAL_GEAR_TEETH_MIN,
            INTERNAL_GEAR_TEETH_MAX,
        )
        normalized['outerDiameter'] = require_number(
            shape.get('outerDiameter'),
            'shapes[{}].outerDiameter'.format(index),
            True,
        )
        if normalized['mode'] != 'add':
            raise ValueError('internalGear only supports add mode.')

    if shape_type in ('gear', 'rack', 'internalGear'):
        if not GEAR_MODULE_MIN <= normalized['module'] <= GEAR_MODULE_MAX:
            raise ValueError('module must be between {} and {}.'.format(GEAR_MODULE_MIN, GEAR_MODULE_MAX))
    return normalized


def normalize_document(document_data):
    if not isinstance(document_data, dict):
        raise ValueError('JSON root must be an object.')
    schema_version = int(document_data.get('schemaVersion', 1))
    if schema_version > MODEL_SCHEMA_VERSION:
        raise ValueError(
            'Unsupported schemaVersion {}. This add-in supports up to {}.'.format(
                schema_version,
                MODEL_SCHEMA_VERSION,
            )
        )
    default_face = document_data.get('activeFace', 'top')
    shapes = [
        normalize_shape(shape, index, default_face)
        for index, shape in enumerate(document_data.get('shapes', []))
    ]
    if not shapes:
        raise ValueError('JSON has no valid shapes.')

    normalized = dict(document_data)
    normalized['schemaVersion'] = schema_version
    normalized['shapes'] = shapes
    normalized['areaLocks'] = {
        face: bool(document_data.get('areaLocks', {}).get(face))
        for face in FACE_ORDER
    }
    normalized['areaLockConstraints'] = {
        face: normalize_constraint(document_data.get('areaLockConstraints', {}).get(face))
        for face in FACE_ORDER
    }
    normalized['partName'] = document_data.get('partName') or 'oshidasumaho-cad-part'
    return normalized


def get_gear_radii(shape):
    module_value = clamp(float(shape['module']), GEAR_MODULE_MIN, GEAR_MODULE_MAX)
    teeth = int(clamp(int(shape['teeth']), GEAR_TEETH_MIN, GEAR_TEETH_MAX))
    pitch_radius = module_value * teeth / 2.0
    base_radius = pitch_radius * math.cos(math.radians(GEAR_PRESSURE_ANGLE_DEG))
    outer_radius = pitch_radius + module_value
    root_radius = max(module_value, pitch_radius - 1.25 * module_value)
    bore_radius = clamp(float(shape.get('bore', 0)) / 2.0, 0, max(0, root_radius - 0.1))
    return {
        'module': module_value,
        'teeth': teeth,
        'pitchRadius': pitch_radius,
        'baseRadius': base_radius,
        'outerRadius': outer_radius,
        'rootRadius': root_radius,
        'boreRadius': bore_radius,
    }


def involute_angle(radius, base_radius):
    if radius <= base_radius:
        return 0
    parameter = math.sqrt((radius / base_radius) ** 2 - 1)
    return parameter - math.atan(parameter)


def polar_point(center_x, center_y, radius, angle):
    return (
        center_x + math.cos(angle) * radius,
        center_y + math.sin(angle) * radius,
    )


def get_gear_outline(shape, flank_samples=4, tip_samples=3):
    radii = get_gear_radii(shape)
    pitch_angle = math.pi * 2 / radii['teeth']
    half_tooth_at_pitch = math.pi / (2 * radii['teeth'])
    pitch_involute = involute_angle(radii['pitchRadius'], radii['baseRadius'])
    flank_start_radius = max(radii['rootRadius'], radii['baseRadius'])
    flank_start_involute = involute_angle(flank_start_radius, radii['baseRadius'])
    flank_start_half_angle = half_tooth_at_pitch + pitch_involute - flank_start_involute
    outer_involute = involute_angle(radii['outerRadius'], radii['baseRadius'])
    outer_half_angle = half_tooth_at_pitch + pitch_involute - outer_involute
    profile = [
        (-pitch_angle / 2, radii['rootRadius']),
        (-flank_start_half_angle, radii['rootRadius']),
    ]
    for index in range(flank_samples + 1):
        ratio = index / flank_samples
        radius = flank_start_radius + (radii['outerRadius'] - flank_start_radius) * ratio
        half_angle = half_tooth_at_pitch + pitch_involute - involute_angle(radius, radii['baseRadius'])
        profile.append((-half_angle, radius))
    for index in range(1, tip_samples + 1):
        ratio = index / (tip_samples + 1)
        profile.append((-outer_half_angle + outer_half_angle * 2 * ratio, radii['outerRadius']))
    for index in range(flank_samples, -1, -1):
        ratio = index / flank_samples
        radius = flank_start_radius + (radii['outerRadius'] - flank_start_radius) * ratio
        half_angle = half_tooth_at_pitch + pitch_involute - involute_angle(radius, radii['baseRadius'])
        profile.append((half_angle, radius))
    profile.extend([
        (flank_start_half_angle, radii['rootRadius']),
        (pitch_angle / 2, radii['rootRadius']),
    ])
    points = []
    for tooth_index in range(radii['teeth']):
        tooth_points = profile if tooth_index == radii['teeth'] - 1 else profile[:-1]
        center_angle = tooth_index * pitch_angle
        points.extend([
            polar_point(shape['x'], shape['y'], radius, center_angle + angle)
            for angle, radius in tooth_points
        ])
    return points


def get_rack_dimensions(shape):
    module_value = clamp(float(shape['module']), GEAR_MODULE_MIN, GEAR_MODULE_MAX)
    teeth = int(clamp(int(shape['teeth']), RACK_TEETH_MIN, RACK_TEETH_MAX))
    pitch = math.pi * module_value
    profile_width = round_model(pitch * teeth)
    width = clamp(round_model(shape['width']), profile_width, min(120, round_model(profile_width + pitch)))
    addendum = module_value
    dedendum = 1.25 * module_value
    tooth_depth = addendum + dedendum
    height = max(float(shape['height']), math.ceil(tooth_depth))
    rotation = int(shape.get('rotation', 0)) % 360
    pressure_offset = math.tan(math.radians(GEAR_PRESSURE_ANGLE_DEG))
    return {
        'module': module_value,
        'teeth': teeth,
        'pitch': pitch,
        'profileWidth': profile_width,
        'width': width,
        'height': height,
        'rotation': rotation,
        'toothDepth': tooth_depth,
        'tipHalfWidth': pitch / 4 - addendum * pressure_offset,
        'rootHalfWidth': pitch / 4 + dedendum * pressure_offset,
        'boundsWidth': height if rotation in (90, 270) else width,
        'boundsHeight': width if rotation in (90, 270) else height,
    }


def rack_local_to_world(shape, dimensions, local_x, local_y):
    if dimensions['rotation'] == 90:
        return (shape['x'] + dimensions['height'] - local_y, shape['y'] + local_x)
    if dimensions['rotation'] == 180:
        return (shape['x'] + dimensions['width'] - local_x, shape['y'] + dimensions['height'] - local_y)
    if dimensions['rotation'] == 270:
        return (shape['x'] + local_y, shape['y'] + dimensions['width'] - local_x)
    return (shape['x'] + local_x, shape['y'] + local_y)


def get_rack_outline(shape):
    dimensions = get_rack_dimensions(shape)
    root_y = dimensions['toothDepth']
    profile = []
    for index in range(dimensions['teeth']):
        start = index * dimensions['pitch']
        center = start + dimensions['pitch'] / 2
        points = [
            (start, root_y),
            (center - dimensions['rootHalfWidth'], root_y),
            (center - dimensions['tipHalfWidth'], 0),
            (center + dimensions['tipHalfWidth'], 0),
            (center + dimensions['rootHalfWidth'], root_y),
            (min(start + dimensions['pitch'], dimensions['profileWidth']), root_y),
        ]
        profile.extend(points if index == 0 else points[1:])
    profile.extend([
        (dimensions['width'], root_y),
        (dimensions['width'], dimensions['height']),
        (0, dimensions['height']),
    ])
    return [rack_local_to_world(shape, dimensions, x, y) for x, y in profile]


def get_internal_gear_radii(shape):
    module_value = clamp(float(shape['module']), GEAR_MODULE_MIN, GEAR_MODULE_MAX)
    teeth = int(clamp(int(shape['teeth']), INTERNAL_GEAR_TEETH_MIN, INTERNAL_GEAR_TEETH_MAX))
    pitch_radius = module_value * teeth / 2
    base_radius = pitch_radius * math.cos(math.radians(GEAR_PRESSURE_ANGLE_DEG))
    tip_radius = pitch_radius - module_value
    root_radius = pitch_radius + 1.25 * module_value
    minimum_rim = max(1, module_value / 2)
    outer_radius = max(root_radius + minimum_rim, float(shape['outerDiameter']) / 2)
    return {
        'module': module_value,
        'teeth': teeth,
        'pitchRadius': pitch_radius,
        'baseRadius': base_radius,
        'tipRadius': tip_radius,
        'rootRadius': root_radius,
        'outerRadius': outer_radius,
    }


def get_internal_gear_inner_outline(shape, flank_samples=4, tip_samples=2, root_samples=2):
    radii = get_internal_gear_radii(shape)
    pitch_angle = math.pi * 2 / radii['teeth']
    half_space_at_pitch = math.pi / (2 * radii['teeth'])
    pitch_involute = involute_angle(radii['pitchRadius'], radii['baseRadius'])
    tip_half_angle = half_space_at_pitch + pitch_involute - involute_angle(
        radii['tipRadius'],
        radii['baseRadius'],
    )
    root_half_angle = half_space_at_pitch + pitch_involute - involute_angle(
        radii['rootRadius'],
        radii['baseRadius'],
    )
    profile = [(-pitch_angle / 2, radii['tipRadius'])]
    for index in range(1, tip_samples + 1):
        ratio = index / tip_samples
        profile.append((
            -pitch_angle / 2 + (pitch_angle / 2 - tip_half_angle) * ratio,
            radii['tipRadius'],
        ))
    for index in range(1, flank_samples + 1):
        ratio = index / flank_samples
        radius = radii['tipRadius'] + (radii['rootRadius'] - radii['tipRadius']) * ratio
        half_angle = half_space_at_pitch + pitch_involute - involute_angle(radius, radii['baseRadius'])
        profile.append((-half_angle, radius))
    for index in range(1, root_samples + 1):
        ratio = index / (root_samples + 1)
        profile.append((-root_half_angle + root_half_angle * 2 * ratio, radii['rootRadius']))
    for index in range(flank_samples, -1, -1):
        ratio = index / flank_samples
        radius = radii['tipRadius'] + (radii['rootRadius'] - radii['tipRadius']) * ratio
        half_angle = half_space_at_pitch + pitch_involute - involute_angle(radius, radii['baseRadius'])
        profile.append((half_angle, radius))
    for index in range(1, tip_samples + 1):
        ratio = index / tip_samples
        profile.append((
            tip_half_angle + (pitch_angle / 2 - tip_half_angle) * ratio,
            radii['tipRadius'],
        ))
    points = []
    for tooth_index in range(radii['teeth']):
        tooth_points = profile if tooth_index == radii['teeth'] - 1 else profile[:-1]
        center_angle = tooth_index * pitch_angle
        points.extend([
            polar_point(shape['x'], shape['y'], radius, center_angle + angle)
            for angle, radius in tooth_points
        ])
    return list(reversed(points))


def circle_profile(x, y, radius):
    return {'kind': 'circle', 'center': (x, y), 'radius': radius}


def polyline_profile(points):
    cleaned = []
    for point in points:
        normalized = (float(point[0]), float(point[1]))
        if not cleaned or math.dist(cleaned[-1], normalized) > 0.000001:
            cleaned.append(normalized)
    if len(cleaned) > 1 and math.dist(cleaned[0], cleaned[-1]) <= 0.000001:
        cleaned.pop()
    if len(cleaned) < 3:
        raise ValueError('A polyline profile requires at least three unique points.')
    return {'kind': 'polyline', 'points': cleaned}


def get_shape_profiles(shape):
    shape_type = shape['type']
    if shape_type == 'rect':
        x = shape['x']
        y = shape['y']
        return {
            'outer': polyline_profile([
                (x, y),
                (x + shape['w'], y),
                (x + shape['w'], y + shape['h']),
                (x, y + shape['h']),
            ]),
            'holes': [],
        }
    if shape_type == 'circle':
        return {'outer': circle_profile(shape['x'], shape['y'], shape['r']), 'holes': []}
    if shape_type == 'gear':
        radii = get_gear_radii(shape)
        holes = []
        if radii['boreRadius'] > EPSILON_MM:
            holes.append(circle_profile(shape['x'], shape['y'], radii['boreRadius']))
        return {'outer': polyline_profile(get_gear_outline(shape)), 'holes': holes}
    if shape_type == 'rack':
        return {'outer': polyline_profile(get_rack_outline(shape)), 'holes': []}
    radii = get_internal_gear_radii(shape)
    return {
        'outer': circle_profile(shape['x'], shape['y'], radii['outerRadius']),
        'holes': [polyline_profile(get_internal_gear_inner_outline(shape))],
    }


def get_shape_bounds(shape):
    profiles = get_shape_profiles(shape)
    outer = profiles['outer']
    if outer['kind'] == 'circle':
        x, y = outer['center']
        radius = outer['radius']
        return {'minX': x - radius, 'maxX': x + radius, 'minY': y - radius, 'maxY': y + radius}
    xs = [point[0] for point in outer['points']]
    ys = [point[1] for point in outer['points']]
    return {'minX': min(xs), 'maxX': max(xs), 'minY': min(ys), 'maxY': max(ys)}


def merge_bounds(bounds_list):
    if not bounds_list:
        return None
    return {
        'minX': min(bounds['minX'] for bounds in bounds_list),
        'maxX': max(bounds['maxX'] for bounds in bounds_list),
        'minY': min(bounds['minY'] for bounds in bounds_list),
        'maxY': max(bounds['maxY'] for bounds in bounds_list),
    }


def get_add_shape_bounds(document_data, face):
    return merge_bounds([
        get_shape_bounds(shape)
        for shape in document_data['shapes']
        if shape['face'] == face and shape['mode'] != 'cut'
    ])


def intersect_ranges(ranges):
    valid = [range_data for range_data in ranges if range_data]
    if not valid:
        return None
    minimum = max(range_data['min'] for range_data in valid)
    maximum = min(range_data['max'] for range_data in valid)
    if maximum - minimum <= EPSILON_MM:
        raise ValueError('The three face ranges do not define a common model dimension.')
    return {'min': minimum, 'max': maximum, 'size': maximum - minimum}


def get_document_dimensions(document_data):
    ranges_by_dimension = {'width': [], 'depth': [], 'height': []}
    for face in FACE_ORDER:
        constraint = document_data['areaLockConstraints'].get(face)
        bounds = constraint if document_data['areaLocks'].get(face) and constraint else get_add_shape_bounds(document_data, face)
        if not bounds:
            continue
        for axis in ('x', 'y'):
            dimension = FACE_AXES[face][axis]
            ranges_by_dimension[dimension].append({
                'min': bounds['minX'] if axis == 'x' else bounds['minY'],
                'max': bounds['maxX'] if axis == 'x' else bounds['maxY'],
            })
    dimensions = {
        name: intersect_ranges(ranges)
        for name, ranges in ranges_by_dimension.items()
    }
    missing = [name for name, value in dimensions.items() if not value]
    if missing:
        raise ValueError('Add shapes are required on all three faces: {}'.format(', '.join(missing)))
    return dimensions
