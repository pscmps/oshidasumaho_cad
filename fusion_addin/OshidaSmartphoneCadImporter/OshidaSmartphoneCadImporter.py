import json
import math
import traceback

import adsk.core
import adsk.fusion


APP_NAME = 'Oshida Smartphone CAD Importer'
COMMAND_ID = 'oshidaSmartphoneCadImportJson'
COMMAND_NAME = 'Import Oshida CAD JSON'
COMMAND_DESCRIPTION = 'Import Oshida Smartphone CAD JSON as Fusion solid geometry.'
WORKSPACE_ID = 'FusionSolidEnvironment'
PANEL_ID = 'SolidScriptsAddinsPanel'
FACE_ORDER = ('top', 'front', 'right')
FACE_AXES = {
    'top': {'x': 'width', 'y': 'depth'},
    'front': {'x': 'width', 'y': 'height'},
    'right': {'x': 'depth', 'y': 'height'},
}
EPSILON_MM = 0.001

app = None
ui = None
handlers = []


def run(context):
    global app, ui
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface

        command_definition = ui.commandDefinitions.itemById(COMMAND_ID)
        if not command_definition:
            command_definition = ui.commandDefinitions.addButtonDefinition(
                COMMAND_ID,
                COMMAND_NAME,
                COMMAND_DESCRIPTION,
            )

        on_created = CommandCreatedHandler()
        command_definition.commandCreated.add(on_created)
        handlers.append(on_created)

        panel = ui.workspaces.itemById(WORKSPACE_ID).toolbarPanels.itemById(PANEL_ID)
        control = panel.controls.itemById(COMMAND_ID)
        if not control:
            control = panel.controls.addCommand(command_definition)
            control.isPromoted = True
    except Exception:
        if ui:
            ui.messageBox('Failed to start add-in:\n{}'.format(traceback.format_exc()))


def stop(context):
    try:
        command_definition = ui.commandDefinitions.itemById(COMMAND_ID) if ui else None
        if command_definition:
            control = ui.workspaces.itemById(WORKSPACE_ID).toolbarPanels.itemById(PANEL_ID).controls.itemById(COMMAND_ID)
            if control:
                control.deleteMe()
            command_definition.deleteMe()
    except Exception:
        if ui:
            ui.messageBox('Failed to stop add-in:\n{}'.format(traceback.format_exc()))


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            command = args.command
            command.isExecutedWhenPreEmpted = False
            inputs = command.commandInputs
            inputs.addTextBoxCommandInput(
                'description',
                'Import',
                'Select an Oshida Smartphone CAD JSON file. The importer builds one swept body for each face and intersects the three bodies.',
                3,
                True,
            )

            on_execute = CommandExecuteHandler()
            command.execute.add(on_execute)
            handlers.append(on_execute)
        except Exception:
            if ui:
                ui.messageBox('Command setup failed:\n{}'.format(traceback.format_exc()))


class CommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            path = pick_json_file()
            if not path:
                return
            with open(path, 'r', encoding='utf-8') as file:
                document_data = normalize_document(json.load(file))

            importer = FusionImporter(document_data)
            body = importer.import_part()
            if body:
                ui.messageBox('Imported: {}'.format(body.name))
        except Exception:
            if ui:
                ui.messageBox('Import failed:\n{}'.format(traceback.format_exc()))


def pick_json_file():
    dialog = ui.createFileDialog()
    dialog.title = 'Select Oshida Smartphone CAD JSON'
    dialog.filter = 'JSON files (*.json);;All files (*.*)'
    if dialog.showOpen() != adsk.core.DialogResults.DialogOK:
        return None
    return dialog.filename


def normalize_face(face):
    if face == 'left':
        return 'front'
    return face if face in FACE_ORDER else 'top'


def normalize_document(document_data):
    shapes = []
    for shape in document_data.get('shapes', []):
        normalized = dict(shape)
        normalized['face'] = normalize_face(shape.get('face', document_data.get('activeFace', 'top')))
        normalized['mode'] = 'cut' if shape.get('mode') == 'cut' else 'add'
        if normalized.get('type') not in ('rect', 'circle'):
            continue
        shapes.append(normalized)

    if not shapes:
        raise ValueError('JSONに有効な図形がありません。')

    normalized_document = dict(document_data)
    normalized_document['shapes'] = shapes
    normalized_document['areaLocks'] = {
        face: bool(document_data.get('areaLocks', {}).get(face))
        for face in FACE_ORDER
    }
    normalized_document['areaLockConstraints'] = {
        face: normalize_constraint(document_data.get('areaLockConstraints', {}).get(face))
        for face in FACE_ORDER
    }
    normalized_document['partName'] = document_data.get('partName') or 'oshidasumaho-cad-part'
    return normalized_document


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


def get_shape_bounds(shape):
    if shape.get('type') == 'circle':
        x = float(shape.get('x', 0))
        y = float(shape.get('y', 0))
        r = float(shape.get('r', 0))
        return {'minX': x - r, 'maxX': x + r, 'minY': y - r, 'maxY': y + r}

    x = float(shape.get('x', 0))
    y = float(shape.get('y', 0))
    return {
        'minX': x,
        'maxX': x + float(shape.get('w', 0)),
        'minY': y,
        'maxY': y + float(shape.get('h', 0)),
    }


def merge_bounds(bounds_list):
    valid = [bounds for bounds in bounds_list if bounds]
    if not valid:
        return None
    return {
        'minX': min(bounds['minX'] for bounds in valid),
        'maxX': max(bounds['maxX'] for bounds in valid),
        'minY': min(bounds['minY'] for bounds in valid),
        'maxY': max(bounds['maxY'] for bounds in valid),
    }


def get_add_shape_bounds(document_data, face):
    return merge_bounds([
        get_shape_bounds(shape)
        for shape in document_data['shapes']
        if normalize_face(shape.get('face')) == face and shape.get('mode') != 'cut'
    ])


def intersect_ranges(ranges):
    valid = [range_data for range_data in ranges if range_data]
    if not valid:
        return None
    min_value = max(range_data['min'] for range_data in valid)
    max_value = min(range_data['max'] for range_data in valid)
    if max_value - min_value > EPSILON_MM:
        return {'min': min_value, 'max': max_value, 'size': max_value - min_value}
    min_value = min(range_data['min'] for range_data in valid)
    max_value = max(range_data['max'] for range_data in valid)
    if max_value - min_value <= EPSILON_MM:
        raise ValueError('3面の範囲から有効な寸法を作れません。')
    return {'min': min_value, 'max': max_value, 'size': max_value - min_value}


def get_dimension_range_from_face(face, axis, bounds):
    if not bounds:
        return None
    return {
        'dimension': FACE_AXES[face][axis],
        'min': bounds['minX'] if axis == 'x' else bounds['minY'],
        'max': bounds['maxX'] if axis == 'x' else bounds['maxY'],
    }


def get_document_dimensions(document_data):
    ranges_by_dimension = {'width': [], 'depth': [], 'height': []}

    for face in FACE_ORDER:
        constraint = document_data.get('areaLockConstraints', {}).get(face)
        bounds = constraint if document_data.get('areaLocks', {}).get(face) and constraint else get_add_shape_bounds(document_data, face)
        for axis in ('x', 'y'):
            range_data = get_dimension_range_from_face(face, axis, bounds)
            if range_data:
                ranges_by_dimension[range_data['dimension']].append(range_data)

    dimensions = {
        name: intersect_ranges(ranges)
        for name, ranges in ranges_by_dimension.items()
    }
    missing = [name for name, value in dimensions.items() if not value]
    if missing:
        raise ValueError('寸法を決めるため、上面・正面・右側面にadd図形が必要です: {}'.format(', '.join(missing)))
    return dimensions


def mm_to_cm(value):
    return float(value) / 10.0


def centered_mm(value, dimension):
    return float(value) - dimension['min'] - dimension['size'] / 2.0


def value_mm(amount):
    return adsk.core.ValueInput.createByString('{:.9f} mm'.format(float(amount)))


def clean_name(name):
    allowed = []
    for character in str(name):
        if character.isalnum() or character in ('-', '_', ' '):
            allowed.append(character)
        else:
            allowed.append('-')
    return ''.join(allowed).strip() or 'oshidasumaho-cad-part'


class FusionImporter:
    def __init__(self, document_data):
        self.document = document_data
        self.design = adsk.fusion.Design.cast(app.activeProduct)
        if not self.design:
            raise RuntimeError('Fusion Design workspaceで実行してください。')
        self.root = self.design.rootComponent
        self.dimensions = get_document_dimensions(document_data)
        self.created_planes = []
        self.created_sketches = []

    def import_part(self):
        face_bodies = []
        for face in FACE_ORDER:
            body = self.build_face_body(face)
            if not body:
                raise ValueError('{}面に有効なadd図形がありません。'.format(face))
            body.name = '{}_sweep'.format(face)
            face_bodies.append(body)

        final_body = face_bodies[0]
        for tool_body in face_bodies[1:]:
            final_body = self.combine(final_body, [tool_body], adsk.fusion.FeatureOperations.IntersectFeatureOperation)

        final_body.name = clean_name(self.document.get('partName'))
        self.hide_construction()
        return final_body

    def build_face_body(self, face):
        body = None
        face_shapes = [
            shape
            for shape in self.document['shapes']
            if normalize_face(shape.get('face')) == face
        ]
        for shape in face_shapes:
            prism = self.create_shape_prism(face, shape)
            if shape.get('mode') == 'cut':
                if body:
                    body = self.combine(body, [prism], adsk.fusion.FeatureOperations.CutFeatureOperation)
                else:
                    prism.deleteMe()
                continue

            if body:
                body = self.combine(body, [prism], adsk.fusion.FeatureOperations.JoinFeatureOperation)
            else:
                body = prism
        return body

    def combine(self, target_body, tool_bodies, operation):
        tools = adsk.core.ObjectCollection.create()
        for body in tool_bodies:
            if body:
                tools.add(body)
        combine_input = self.root.features.combineFeatures.createInput(target_body, tools)
        combine_input.operation = operation
        combine_input.isKeepToolBodies = False
        result = self.root.features.combineFeatures.add(combine_input)
        if result.bodies.count < 1:
            return target_body
        return result.bodies.item(0)

    def create_shape_prism(self, face, shape):
        sketch = self.create_face_sketch(face)
        self.draw_shape(sketch, face, shape)
        if sketch.profiles.count < 1:
            raise ValueError('図形からプロファイルを作成できません: {}'.format(shape))
        profile = sketch.profiles.item(0)
        extrudes = self.root.features.extrudeFeatures
        extrude_input = extrudes.createInput(profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        distance, direction = self.get_extrude_distance_and_direction(face)
        extent = adsk.fusion.DistanceExtentDefinition.create(value_mm(distance))
        extrude_input.setOneSideExtent(extent, direction)
        feature = extrudes.add(extrude_input)
        if feature.bodies.count < 1:
            raise ValueError('押し出しボディを作成できません。')
        body = feature.bodies.item(0)
        body.name = '{}_{}_{}'.format(face, shape.get('mode', 'add'), shape.get('id', 'shape'))
        return body

    def create_face_sketch(self, face):
        plane = self.create_face_plane(face)
        sketch = self.root.sketches.add(plane)
        sketch.name = 'OSC_{}_profile'.format(face)
        self.created_sketches.append(sketch)
        return sketch

    def create_face_plane(self, face):
        planes = self.root.constructionPlanes
        plane_input = planes.createInput()
        if face == 'top':
            base_plane = self.root.xYConstructionPlane
            offset = -self.dimensions['height']['size'] / 2.0
        elif face == 'front':
            base_plane = self.root.xZConstructionPlane
            offset = self.dimensions['depth']['size'] / 2.0
        else:
            base_plane = self.root.yZConstructionPlane
            offset = -self.dimensions['width']['size'] / 2.0
        plane_input.setByOffset(base_plane, value_mm(offset))
        plane = planes.add(plane_input)
        plane.name = 'OSC_{}_start'.format(face)
        self.created_planes.append(plane)
        return plane

    def get_extrude_distance_and_direction(self, face):
        if face == 'top':
            return self.dimensions['height']['size'], adsk.fusion.ExtentDirections.PositiveExtentDirection
        if face == 'front':
            return self.dimensions['depth']['size'], adsk.fusion.ExtentDirections.NegativeExtentDirection
        return self.dimensions['width']['size'], adsk.fusion.ExtentDirections.PositiveExtentDirection

    def draw_shape(self, sketch, face, shape):
        if shape.get('type') == 'circle':
            center = self.get_sketch_point(face, float(shape.get('x', 0)), float(shape.get('y', 0)))
            sketch.sketchCurves.sketchCircles.addByCenterRadius(center, mm_to_cm(shape.get('r', 0)))
            return

        x = float(shape.get('x', 0))
        y = float(shape.get('y', 0))
        w = float(shape.get('w', 0))
        h = float(shape.get('h', 0))
        p1 = self.get_sketch_point(face, x, y)
        p2 = self.get_sketch_point(face, x + w, y)
        p3 = self.get_sketch_point(face, x + w, y + h)
        p4 = self.get_sketch_point(face, x, y + h)
        lines = sketch.sketchCurves.sketchLines
        lines.addByTwoPoints(p1, p2)
        lines.addByTwoPoints(p2, p3)
        lines.addByTwoPoints(p3, p4)
        lines.addByTwoPoints(p4, p1)

    def get_sketch_point(self, face, first, second):
        if face == 'top':
            u = centered_mm(first, self.dimensions['width'])
            v = centered_mm(second, self.dimensions['depth'])
        elif face == 'front':
            u = centered_mm(first, self.dimensions['width'])
            v = centered_mm(second, self.dimensions['height'])
        else:
            u = centered_mm(first, self.dimensions['depth'])
            v = centered_mm(second, self.dimensions['height'])
        return adsk.core.Point3D.create(mm_to_cm(u), mm_to_cm(v), 0)

    def hide_construction(self):
        for sketch in self.created_sketches:
            sketch.isVisible = False
        for plane in self.created_planes:
            plane.isLightBulbOn = False


def _test_dimensions(document_data):
    return get_document_dimensions(normalize_document(document_data))
