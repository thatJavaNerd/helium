import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { MatDialog } from '@angular/material';
import { isEqual, zipObject } from 'lodash';
import { delay, startWith } from 'rxjs/operators';
import { Constraint, SqlRow, TableMeta } from '../../common/api';
import { flattenCompoundConstraints } from '../../common/util';
import { FormControlSpec } from '../../dynamic-forms/form-control-spec';
import { FormSpecGeneratorService } from '../../dynamic-forms/form-spec-generator/form-spec-generator.service';
import { RowPickerDialogComponent, RowPickerParams } from '../row-picker-dialog/row-picker-dialog.component';

/**
 * Shows a dynamically generated form based on the provided table metadata.
 * Similar conceptually to Angular's FormGroup, but more specialized to our
 * needs.
 */
@Component({
    selector: 'form-entry',
    templateUrl: 'form-entry.component.html',
    styleUrls: ['form-entry.component.scss']
})
export class FormEntryComponent implements OnChanges {
    /** The table to generate a form for */
    @Input('for')
    public meta: TableMeta;

    /** Emits a snapshot of the form whenever an input is updated */
    @Output()
    public entryUpdated = new EventEmitter<FormEntrySnapshot>();

    /** The current form value */
    public get value(): SqlRow { return this.group.getRawValue(); }

    /** If the form is valid */
    public get valid() { return this.group.valid; }

    /**
     * Generated FormControlSpecs given to/generated by the dynamic forms module
     */
    public formSpecs: FormControlSpec[];

    public group: FormGroup;

    public constructor(
        private formSpecGenerator: FormSpecGeneratorService,
        private dialog: MatDialog
    ) {}

    public ngOnChanges() {
        // Generate the form control specs
        this.formSpecs = this.formSpecGenerator.generate(this.meta,
            (col) => this.handleRowPickerRequested(col));

        // Create the from group based on the generated specs
        const controls: { [name: string]: FormControl } = zipObject(
            this.meta.headers.map((h) => h.name),
            this.formSpecs.map((spec) => {
                return new FormControl(spec.defaultValue, spec.validation);
            })
        );
        this.group = new FormGroup(controls);

        this.group.valueChanges.pipe(
            // Make sure to emit the default values as well
            startWith(this.group.value),
            delay(1)
        ).subscribe(() => {
            this.entryUpdated.emit({
                value: this.value,
                valid: this.valid
            });
        });
    }

    /**
     * Updates the current form. Not all values need be specified. There must
     * be a FormControl for every key in `data`.
     */
    public patchValue(data: { [formControlName: string]: any }) {
        const registeredControls = Object.keys(this.group.controls);
        const specifiedControls = Object.keys(data);

        for (const specifiedControl of specifiedControls) {
            if (!registeredControls.includes(specifiedControl))
                throw new Error(`No such form control with name "${specifiedControl}"`);
        }

        this.group.patchValue(data, { emitEvent: true });
    }

    private handleRowPickerRequested(colName: string) {
        const constraints = flattenCompoundConstraints(this.meta.constraints);
        const foreignKeys = constraints
            .filter((c) => c.type === 'foreign');
        
        // Try to find the foreign key associated with the given column 
        const requestedForeignKey = foreignKeys.find((c: Constraint) => c.localColumn === colName);
        
        if (requestedForeignKey === undefined)
            throw new Error(`Cannot show row picker for column ${colName}: not a foreign key`);

        const ref = requestedForeignKey.ref!!;

        // Open the dialog to let the user pick a row
        const params: RowPickerParams = {
            tableName: ref.table,
            schemaName: ref.schema
        };
        const dialogRef = this.dialog.open(RowPickerDialogComponent, {
            data: params
        });

        dialogRef.afterClosed().subscribe((data: { row: SqlRow, table: TableMeta } | undefined) => {
            // The user closed the dialog before selecting a row
            if (data === undefined)
                return;

            // Foreign keys from the table being plucked from
            const otherForeignKeys = flattenCompoundConstraints(data.table.constraints)
                .filter((c) => c.type === 'foreign');

            const patch: { [col: string]: any } = {};

            for (const selectedColumnName of Object.keys(data.row)) {
                // Try to find other foreign keys in this table that reference
                // the same table as the selected foreign key
                const foreignKey = foreignKeys.find((c) => {
                    return c.ref!.schema === requestedForeignKey.ref!.schema &&
                        c.ref!.table === requestedForeignKey.ref!.table &&
                        c.ref!.column === selectedColumnName;
                });

                if (foreignKey !== undefined) {
                    patch[foreignKey.localColumn] = data.row[selectedColumnName];
                } else {
                    // Try to find foreign keys from this table and the table
                    // being plucked from that reference the same thing. See
                    // #148 for more.
                    const otherKey = foreignKeys.find((c) => {
                        for (const otherFk of otherForeignKeys) {
                            if (otherFk.localColumn === selectedColumnName && isEqual(otherFk.ref, c.ref)) {
                                return true;
                            }
                        }

                        return false;
                    });

                    if (otherKey !== undefined) {
                        patch[otherKey.localColumn] = data.row[selectedColumnName];
                    }
                }
            }

            this.patchValue(patch);
        });
    }
}

export interface FormEntrySnapshot {
    value: SqlRow;
    valid: boolean;
}
